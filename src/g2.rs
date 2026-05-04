use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::json_escape;

use rquickjs::{promise::MaybePromise, Context, FromJs, Function, Runtime};
use serde::Serialize;
use skia_safe::font_style::{Slant, Weight, Width};
use skia_safe::{Font, FontMgr, FontStyle};

const G2_HOST_RUNTIME: &str = include_str!("g2_host_runtime.js");
const DEFAULT_G2_SCRIPT: &str = include_str!("../examples/g2-stacked-area.js");

#[derive(Debug, Clone)]
pub struct ProbeLog {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct G2ProbeReport {
    pub ok: bool,
    pub result_json: Option<String>,
    pub error: Option<String>,
    pub logs: Vec<ProbeLog>,
}

#[derive(Debug, Clone, Serialize)]
pub struct G2RunOptions {
    pub width: u32,
    pub height: u32,
    #[serde(rename = "containerId")]
    pub container_id: String,
}

impl Default for G2RunOptions {
    fn default() -> Self {
        Self {
            width: 960,
            height: 540,
            container_id: "container".into(),
        }
    }
}

#[derive(Debug)]
pub enum G2ProbeError {
    Js(String),
    Io(String),
}

impl std::fmt::Display for G2ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            G2ProbeError::Js(e) => write!(f, "JS error: {e}"),
            G2ProbeError::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

impl std::error::Error for G2ProbeError {}

pub struct G2Probe {
    #[allow(dead_code)]
    runtime: Runtime,
    context: Context,
    logs: Arc<Mutex<Vec<ProbeLog>>>,
}

impl G2Probe {
    pub fn new() -> Result<Self, G2ProbeError> {
        let runtime = Runtime::new().map_err(|e| G2ProbeError::Js(e.to_string()))?;
        runtime.set_max_stack_size(16 * 1024 * 1024);

        let context = Context::full(&runtime).map_err(|e| G2ProbeError::Js(e.to_string()))?;
        let logs = Arc::new(Mutex::new(Vec::new()));
        let bundle = fs::read_to_string(g2_bundle_path())
            .map_err(|e| G2ProbeError::Io(format!("failed to read g2 bundle: {e}")))?;

        context.with(|ctx| {
            install_logger(&ctx, logs.clone())?;
            ctx.eval::<(), _>(G2_HOST_RUNTIME)
                .map_err(|e| G2ProbeError::Js(format!("{e:?}")))?;
            ctx.eval::<(), _>(bundle.as_str())
                .map_err(|e| G2ProbeError::Js(format!("{e:?}")))?;
            Ok::<(), G2ProbeError>(())
        })?;

        Ok(Self {
            runtime,
            context,
            logs,
        })
    }

    pub fn run_sample_chart(&self) -> Result<G2ProbeReport, G2ProbeError> {
        self.run_script(DEFAULT_G2_SCRIPT, &G2RunOptions::default())
    }

    pub fn run_script(
        &self,
        script_source: &str,
        options: &G2RunOptions,
    ) -> Result<G2ProbeReport, G2ProbeError> {
        self.clear_logs();

        self.context.with(|ctx| {
            let options_json = serde_json::to_string(options)
                .map_err(|e| G2ProbeError::Js(format!("failed to serialize options: {e}")))?;
            let script = format!(
                r#"
                (async function () {{
                  return JSON.stringify(
                    await globalThis.runG2Probe({}, {})
                  );
                }})()
            "#,
                json_escape(script_source),
                options_json
            );

            let promise = match ctx.eval::<MaybePromise<'_>, _>(script.as_str()) {
                Ok(promise) => promise,
                Err(rquickjs::Error::Exception) => {
                    return Ok(G2ProbeReport {
                        ok: false,
                        result_json: None,
                        error: Some(js_exception_message(&ctx)),
                        logs: self.snapshot_logs(),
                    });
                }
                Err(error) => return Err(G2ProbeError::Js(error.to_string())),
            };

            let outcome = match promise.finish::<String>() {
                Ok(result_json) => G2ProbeReport {
                    ok: true,
                    result_json: Some(result_json),
                    error: None,
                    logs: self.snapshot_logs(),
                },
                Err(rquickjs::Error::Exception) => G2ProbeReport {
                    ok: false,
                    result_json: None,
                    error: Some(js_exception_message(&ctx)),
                    logs: self.snapshot_logs(),
                },
                Err(rquickjs::Error::WouldBlock) => {
                    let mut logs = self.snapshot_logs();
                    if let Some(result_json) = eval_string(
                        &ctx,
                        format!(
                            r#"
                            JSON.stringify(
                              globalThis.collectCurrentG2ProbeState
                                ? globalThis.collectCurrentG2ProbeState({})
                                : null
                            )
                            "#,
                            options_json
                        )
                        .as_str(),
                    ) {
                        if result_json != "null" {
                            logs.push(ProbeLog {
                                level: "warn".into(),
                                message:
                                    "render promise did not settle; using current static frame".into(),
                            });
                            return Ok(G2ProbeReport {
                                ok: true,
                                result_json: Some(result_json),
                                error: None,
                                logs,
                            });
                        }
                    }
                    if let Some(trace_tail) = eval_string(
                        &ctx,
                        r#"
                        JSON.stringify(
                          (globalThis.__getFakeCanvasKitTrace
                            ? globalThis.__getFakeCanvasKitTrace().slice(-40)
                            : [])
                        )
                        "#,
                    ) {
                        logs.push(ProbeLog {
                            level: "trace".into(),
                            message: format!("fakeCanvasKit.tail={trace_tail}"),
                        });
                    }
                    if let Some(console_tail) = eval_string(
                        &ctx,
                        r#"
                        JSON.stringify(
                          (globalThis.__getHostConsoleEntries
                            ? globalThis.__getHostConsoleEntries().slice(-20)
                            : [])
                        )
                        "#,
                    ) {
                        logs.push(ProbeLog {
                            level: "trace".into(),
                            message: format!("hostConsole.tail={console_tail}"),
                        });
                    }
                    G2ProbeReport {
                        ok: false,
                        result_json: None,
                        error: Some("promise did not settle before the job queue drained".into()),
                        logs,
                    }
                }
                Err(error) => {
                    return Err(G2ProbeError::Js(error.to_string()));
                }
            };

            Ok(outcome)
        })
    }

    fn clear_logs(&self) {
        self.logs.lock().unwrap().clear();
    }

    fn snapshot_logs(&self) -> Vec<ProbeLog> {
        self.logs.lock().unwrap().clone()
    }
}

fn install_logger<'js>(
    ctx: &rquickjs::Ctx<'js>,
    logs: Arc<Mutex<Vec<ProbeLog>>>,
) -> Result<(), G2ProbeError> {
    let globals = ctx.globals();
    globals
        .set(
            "__rust_log",
            Function::new(ctx.clone(), move |level: String, message: String| {
                logs.lock().unwrap().push(ProbeLog { level, message });
                Ok::<_, rquickjs::Error>(())
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_fetch_text",
            Function::new(ctx.clone(), move |url: String| {
                fetch_text(&url).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustFetch", "string", error)
                })
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_measure_text",
            Function::new(
                ctx.clone(),
                move |text: String, font_size: f32, font_families: String, font_weight: i32, italic: bool| {
                    measure_text_json(&text, font_size, &font_families, font_weight, italic)
                        .map_err(|error| {
                            rquickjs::Error::new_from_js_message(
                                "rustMeasureText",
                                "string",
                                error,
                            )
                        })
                },
            )
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    Ok(())
}

fn js_exception_message(ctx: &rquickjs::Ctx<'_>) -> String {
    let ex = ctx.catch();
    String::from_js(ctx, ex).unwrap_or_else(|_| "unknown JS exception".into())
}

fn g2_bundle_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("js")
        .join("g2-bundle.js")
}

fn eval_string(ctx: &rquickjs::Ctx<'_>, script: &str) -> Option<String> {
    ctx.eval::<String, _>(script).ok()
}

fn fetch_text(url: &str) -> Result<String, String> {
    let response = ureq::get(url)
        .call()
        .map_err(|error| format!("fetch failed for {url}: {error}"))?;
    response
        .into_string()
        .map_err(|error| format!("failed to read response body for {url}: {error}"))
}

#[derive(Serialize)]
struct TextMeasure {
    width: f32,
    #[serde(rename = "actualBoundingBoxAscent")]
    actual_bounding_box_ascent: f32,
    #[serde(rename = "actualBoundingBoxDescent")]
    actual_bounding_box_descent: f32,
    #[serde(rename = "fontBoundingBoxAscent")]
    font_bounding_box_ascent: f32,
    #[serde(rename = "fontBoundingBoxDescent")]
    font_bounding_box_descent: f32,
}

fn measure_text_json(
    text: &str,
    font_size: f32,
    font_families: &str,
    font_weight: i32,
    italic: bool,
) -> Result<String, String> {
    let metrics = measure_text(text, font_size, font_families, font_weight, italic);
    serde_json::to_string(&metrics).map_err(|error| error.to_string())
}

fn measure_text(
    text: &str,
    font_size: f32,
    font_families: &str,
    font_weight: i32,
    italic: bool,
) -> TextMeasure {
    let font_size = font_size.max(1.0);
    let style = FontStyle::new(
        Weight::from(font_weight.clamp(*Weight::THIN, *Weight::EXTRA_BLACK)),
        Width::NORMAL,
        if italic { Slant::Italic } else { Slant::Upright },
    );

    let font_mgr = FontMgr::default();
    let typeface = pick_typeface(&font_mgr, font_families, style)
        .or_else(|| font_mgr.legacy_make_typeface(None, style));
    let mut font = match typeface {
        Some(typeface) => Font::new(typeface, font_size),
        None => Font::default(),
    };
    font.set_size(font_size);

    let (width, bounds) = font.measure_str(text, None);
    let (_, metrics) = font.metrics();

    TextMeasure {
        width: width.max(0.0),
        actual_bounding_box_ascent: (-bounds.top).max(0.0),
        actual_bounding_box_descent: bounds.bottom.max(0.0),
        font_bounding_box_ascent: (-metrics.ascent).max(0.0),
        font_bounding_box_descent: metrics.descent.max(0.0),
    }
}

fn pick_typeface(font_mgr: &FontMgr, font_families: &str, style: FontStyle) -> Option<skia_safe::Typeface> {
    for family in font_families.split(',') {
        let family = family.trim().trim_matches('"').trim_matches('\'');
        if family.is_empty() {
            continue;
        }
        if let Some(typeface) = font_mgr.match_family_style(family, style) {
            return Some(typeface);
        }
        if let Some(typeface) = font_mgr.legacy_make_typeface(Some(family), style) {
            return Some(typeface);
        }
    }
    None
}
