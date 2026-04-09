use std::{fs, path::PathBuf};

use katextest::{render_scene_to_png, scene_from_json, G2Probe};

fn main() {
    std::thread::Builder::new()
        .name("g2-probe".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(run_probe)
        .expect("Failed to spawn probe thread")
        .join()
        .expect("Probe thread panicked");
}

fn run_probe() {
    let probe = G2Probe::new().expect("Failed to initialize G2Probe");
    let report = probe
        .run_sample_chart()
        .expect("Failed to execute G2 probe");

    println!("G2 probe ok: {}", report.ok);
    if let Some(result_json) = report.result_json.as_deref() {
        println!("Result: {result_json}");
        let artifacts = PathBuf::from("artifacts");
        fs::create_dir_all(&artifacts).expect("Failed to create artifacts directory");

        let command_path = artifacts.join("g2-commands.json");
        fs::write(&command_path, result_json).expect("Failed to write commands JSON");
        println!("Commands JSON: {}", command_path.display());

        let scene = scene_from_json(result_json).expect("Failed to parse G2 scene JSON");
        let png = render_scene_to_png(&scene).expect("Failed to render G2 scene with skia-safe");
        let png_path = artifacts.join("g2-frame.png");
        fs::write(&png_path, png).expect("Failed to write G2 PNG");
        println!("PNG: {}", png_path.display());
    }
    if let Some(error) = report.error.as_deref() {
        println!("Error: {error}");
    }

    println!("Logs:");
    for log in report.logs {
        println!("[{}] {}", log.level, log.message);
    }
}
