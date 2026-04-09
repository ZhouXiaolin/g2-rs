use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use rquickjs::{promise::MaybePromise, Context, FromJs, Function, Runtime};

const G2_HOST_RUNTIME: &str = include_str!("g2_host_runtime.js");

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
        self.clear_logs();

        self.context.with(|ctx| {
            let script = r#"
                (async function () {
                  return JSON.stringify(await globalThis.runG2Probe());
                })()
            "#;

            let promise = match ctx.eval::<MaybePromise<'_>, _>(script) {
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
