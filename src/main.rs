use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

use g2_rs::{render_scene_to_png, scene_from_json, G2Probe, G2RunOptions, ProbeLog};

struct Cli {
    input: String,
    output_dir: PathBuf,
    width: u32,
    height: u32,
    container_id: String,
    name: Option<String>,
}

fn main() {
    std::thread::Builder::new()
        .name("g2-probe".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(run_cli)
        .expect("Failed to spawn probe thread")
        .join()
        .expect("Probe thread panicked");
}

fn run_cli() {
    let cli = parse_args().unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });

    let script = read_script(&cli.input).unwrap_or_else(|error| {
        eprintln!("Failed to read G2 script: {error}");
        std::process::exit(1);
    });

    let probe = G2Probe::new().unwrap_or_else(|error| {
        eprintln!("Failed to initialize G2Probe: {error}");
        std::process::exit(1);
    });

    let options = G2RunOptions {
        width: cli.width,
        height: cli.height,
        container_id: cli.container_id.clone(),
    };

    let report = probe.run_script(&script, &options).unwrap_or_else(|error| {
        eprintln!("Failed to execute G2 probe: {error}");
        std::process::exit(1);
    });

    let stem = output_stem(&cli);
    let commands_path = cli.output_dir.join(format!("{stem}-commands.json"));
    let png_path = cli.output_dir.join(format!("{stem}-frame.png"));
    let logs_path = cli.output_dir.join(format!("{stem}-logs.txt"));

    fs::create_dir_all(&cli.output_dir).unwrap_or_else(|error| {
        eprintln!(
            "Failed to create output directory {}: {error}",
            cli.output_dir.display()
        );
        std::process::exit(1);
    });

    if let Some(result_json) = report.result_json.as_deref() {
        fs::write(&commands_path, result_json).unwrap_or_else(|error| {
            eprintln!("Failed to write commands JSON: {error}");
            std::process::exit(1);
        });

        let scene = scene_from_json(result_json).unwrap_or_else(|error| {
            eprintln!("Failed to parse G2 scene JSON: {error}");
            std::process::exit(1);
        });
        let png = render_scene_to_png(&scene).unwrap_or_else(|error| {
            eprintln!("Failed to render G2 scene with skia-safe: {error}");
            std::process::exit(1);
        });
        fs::write(&png_path, png).unwrap_or_else(|error| {
            eprintln!("Failed to write PNG: {error}");
            std::process::exit(1);
        });
    }

    let logs_text = format_logs(&report.logs);
    fs::write(&logs_path, logs_text).unwrap_or_else(|error| {
        eprintln!("Failed to write logs: {error}");
        std::process::exit(1);
    });

    println!("G2 probe ok: {}", report.ok);
    println!("Commands JSON: {}", commands_path.display());
    println!("PNG: {}", png_path.display());
    println!("Logs: {}", logs_path.display());
    if let Some(error) = report.error.as_deref() {
        // Degrade like the browser harness: a failed user script still yields a
        // frame (blank/partial) for pixel comparison; the diff reports the gap.
        println!("Error (non-fatal): {error}");
    }
}

fn parse_args() -> Result<Cli, String> {
    let mut input: Option<String> = None;
    let mut output_dir = PathBuf::from("artifacts");
    let mut width = 960;
    let mut height = 540;
    let mut container_id = "container".to_string();
    let mut name: Option<String> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            "-i" | "--input" => {
                input = Some(
                    args.next()
                        .ok_or_else(|| "missing value for --input".to_string())?,
                );
            }
            "-o" | "--output-dir" => {
                output_dir = PathBuf::from(
                    args.next()
                        .ok_or_else(|| "missing value for --output-dir".to_string())?,
                );
            }
            "--width" => {
                width = parse_u32_arg(
                    &args.next()
                        .ok_or_else(|| "missing value for --width".to_string())?,
                    "--width",
                )?;
            }
            "--height" => {
                height = parse_u32_arg(
                    &args.next()
                        .ok_or_else(|| "missing value for --height".to_string())?,
                    "--height",
                )?;
            }
            "--container-id" => {
                container_id = args
                    .next()
                    .ok_or_else(|| "missing value for --container-id".to_string())?;
            }
            "--name" => {
                name = Some(
                    args.next()
                        .ok_or_else(|| "missing value for --name".to_string())?,
                );
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown argument: {value}\n\n{}", help_text()));
            }
            value => {
                if input.is_some() {
                    return Err(format!(
                        "unexpected positional argument: {value}\n\n{}",
                        help_text()
                    ));
                }
                input = Some(value.to_string());
            }
        }
    }

    Ok(Cli {
        input: input.ok_or_else(|| {
            "missing required script path: --input FILE ('-' reads stdin)\n\n".to_string()
                + &help_text()
        })?,
        output_dir,
        width,
        height,
        container_id,
        name,
    })
}

fn parse_u32_arg(value: &str, name: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("invalid value for {name}: {value}"))
}

fn print_help() {
    println!("{}", help_text());
}

fn help_text() -> String {
    [
        "Usage:",
        "  g2-rs --input FILE|- [--output-dir DIR] [--width PX] [--height PX] [--container-id ID] [--name STEM]",
        "",
        "Options:",
        "  -i, --input FILE      G2 demo script (plain JS); '-' reads from stdin",
        "  -o, --output-dir DIR  output directory (default: artifacts)",
        "  --width PX            canvas width (default: 960)",
        "  --height PX           canvas height (default: 540)",
        "  --container-id ID     container element id (default: container)",
        "  --name STEM           output file stem (default: input file stem)",
        "",
        "Examples:",
        "  g2-rs --input examples/column-maxwidth.js",
        "  Get-Content examples/column-maxwidth.js | g2-rs --input - --name column-maxwidth",
    ]
    .join("\n")
}

fn read_script(input: &str) -> Result<String, String> {
    match input {
        "-" => {
            let mut buffer = String::new();
            io::stdin()
                .read_to_string(&mut buffer)
                .map_err(|e| e.to_string())?;
            Ok(buffer)
        }
        path => fs::read_to_string(path).map_err(|e| e.to_string()),
    }
}

fn output_stem(cli: &Cli) -> String {
    if let Some(name) = cli.name.as_deref() {
        return sanitize_stem(name);
    }
    if cli.input == "-" {
        return "stdin".into();
    }
    if let Some(stem) = Path::new(&cli.input).file_stem().and_then(|v| v.to_str()) {
        return sanitize_stem(stem);
    }
    "g2".into()
}

fn sanitize_stem(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() {
        "g2".into()
    } else {
        out
    }
}

fn format_logs(logs: &[ProbeLog]) -> String {
    let mut out = String::new();
    for log in logs {
        out.push('[');
        out.push_str(&log.level);
        out.push_str("] ");
        out.push_str(&log.message);
        out.push('\n');
    }
    out
}
