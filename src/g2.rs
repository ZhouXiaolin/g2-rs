use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::json_escape;

use rquickjs::{promise::MaybePromise, Context, FromJs, Function, Runtime};
use serde::Serialize;
use skia_safe::font_style::{Slant, Weight, Width};
use skia_safe::{Font, FontMgr, FontStyle};

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
            "__rust_fetch_base64",
            Function::new(ctx.clone(), move |url: String| {
                fetch_base64(&url).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustFetchBase64", "string", error)
                })
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_image_size",
            Function::new(ctx.clone(), move |encoded: String| {
                image_size(&encoded).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustImageSize", "string", error)
                })
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_encode_png",
            Function::new(ctx.clone(), move |rgba: String, width: u32, height: u32| {
                encode_png(&rgba, width, height).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustEncodePng", "string", error)
                })
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_image_rgba",
            Function::new(ctx.clone(), move |encoded: String| {
                image_rgba(&encoded).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustImageRgba", "string", error)
                })
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_draw_text",
            Function::new(ctx.clone(), move |args: String| {
                draw_text_json(&args).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustDrawText", "string", error)
                })
            })
            .map_err(|e| G2ProbeError::Js(e.to_string()))?,
        )
        .map_err(|e| G2ProbeError::Js(e.to_string()))?;
    globals
        .set(
            "__rust_rasterize_pattern",
            Function::new(ctx.clone(), move |args: String| {
                rasterize_pattern(&args).map_err(|error| {
                    rquickjs::Error::new_from_js_message("rustRasterizePattern", "string", error)
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

/// Shared agent: ureq 3's top-level `ureq::get()` creates a use-once agent per
/// call, so image-heavy demos pay a fresh TCP+TLS handshake per fetch (~55s for
/// the contributor demo vs <45s batch timeout). One agent keeps connections hot.
fn http_agent() -> &'static ureq::Agent {
    use std::sync::OnceLock;
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(ureq::Agent::new_with_defaults)
}

fn fetch_text(url: &str) -> Result<String, String> {
    let mut response = http_agent()
        .get(url)
        .call()
        .map_err(|error| format!("fetch failed for {url}: {error}"))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("failed to read response body for {url}: {error}"))
}

fn fetch_base64(url: &str) -> Result<String, String> {
    use base64::Engine as _;
    let response = http_agent()
        .get(url)
        .call()
        .map_err(|error| format!("fetch failed for {url}: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_body()
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read response body for {url}: {error}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// PNG IHDR / JPEG SOF header scan; returns {"width":w,"height":h} or 1x1 fallback
/// (only used for naturalWidth/Height defaults — layout sizes come from the spec).
fn image_size(encoded: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("bad base64 image: {error}"))?;
    let (width, height) = sniff_png(&bytes)
        .or_else(|| sniff_jpeg(&bytes))
        .unwrap_or((1, 1));
    Ok(format!("{{\"width\":{width},\"height\":{height}}}"))
}

fn sniff_png(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

fn sniff_jpeg(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 9 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        // SOF0-SOF3 (excluding DHT/JPG/DAC), also SOF5-7, SOF9-11
        if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
            let height = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[i + 7..i + 9].try_into().ok()?) as u32;
            return Some((width, height));
        }
        if matches!(marker, 0xD8 | 0x01) || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes(bytes[i + 2..i + 4].try_into().ok()?) as usize;
        i += 2 + len;
    }
    None
}

/// straight-RGBA base64 -> PNG data URL body (base64). Used by the JS-side 2D
/// rasterizer for canvas.toDataURL().
fn encode_png(rgba: &str, width: u32, height: u32) -> Result<String, String> {
    use base64::Engine as _;
    use skia_safe::{images, AlphaType, ColorType, ImageInfo};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(rgba.trim())
        .map_err(|error| format!("bad base64 rgba: {error}"))?;
    let info = ImageInfo::new(
        (width as i32, height as i32),
        ColorType::RGBA8888,
        AlphaType::Unpremul,
        None,
    );
    if bytes.len() < info.bytes_per_pixel() * width as usize * height as usize {
        return Err("rgba buffer too small".into());
    }
    let image = images::raster_from_data(&info, skia_safe::Data::new_copy(&bytes), info.min_row_bytes())
        .ok_or("failed to build raster image")?;
    let png = image
        .encode(None, skia_safe::EncodedImageFormat::PNG, None)
        .ok_or("png encode failed")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png.as_bytes()))
}

/// RGBA canvas + text draw request -> RGBA canvas with the text rasterized
/// (black-on-red scan by g-lite's font metrics needs real glyphs).
#[derive(serde::Deserialize)]
struct DrawTextArgs {
    rgba: String,
    width: u32,
    height: u32,
    text: String,
    x: f64,
    y: f64,
    #[serde(default = "default_font_size")]
    font_size: f32,
    #[serde(default)]
    font_families: String,
    #[serde(default)]
    font_weight: i32,
    #[serde(default)]
    italic: bool,
    #[serde(default = "default_color_channel")]
    r: u8,
    #[serde(default = "default_color_channel")]
    g: u8,
    #[serde(default = "default_color_channel")]
    b: u8,
    #[serde(default = "default_alpha")]
    a: f64,
}

fn default_font_size() -> f32 {
    12.0
}

fn default_color_channel() -> u8 {
    0
}

fn default_alpha() -> f64 {
    1.0
}

fn draw_text_json(args: &str) -> Result<String, String> {
    let parsed: DrawTextArgs =
        serde_json::from_str(args).map_err(|error| format!("bad draw_text args: {error}"))?;
    draw_text(
        &parsed.rgba,
        parsed.width,
        parsed.height,
        &parsed.text,
        parsed.x,
        parsed.y,
        parsed.font_size,
        &parsed.font_families,
        parsed.font_weight,
        parsed.italic,
        parsed.r,
        parsed.g,
        parsed.b,
        parsed.a,
    )
}

#[allow(clippy::too_many_arguments)]
fn draw_text(
    rgba: &str,
    width: u32,
    height: u32,
    text: &str,
    x: f64,
    y: f64,
    font_size: f32,
    font_families: &str,
    font_weight: i32,
    italic: bool,
    r: u8,
    g: u8,
    b: u8,
    a: f64,
) -> Result<String, String> {
    use base64::Engine as _;
    use skia_safe::{surfaces, AlphaType, Color, ColorType, Font, ImageInfo, Paint};
    use skia_safe::font_style::{Slant, Weight, Width};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(rgba.trim())
        .map_err(|error| format!("bad base64 rgba: {error}"))?;
    let info = ImageInfo::new(
        (width as i32, height as i32),
        ColorType::RGBA8888,
        AlphaType::Unpremul,
        None,
    );
    if bytes.len() < info.min_row_bytes() * height as usize {
        return Err("rgba buffer too small".into());
    }
    let mut surface =
        surfaces::raster(&info, None, None).ok_or_else(|| "failed to create surface".to_string())?;
    let _ = surface
        .canvas()
        .write_pixels(&info, &bytes, info.min_row_bytes(), (0, 0));

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
    font.set_subpixel(true);
    font.set_hinting(skia_safe::FontHinting::None);

    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(Color::from_argb(
        (a.clamp(0.0, 1.0) * 255.0).round() as u8,
        r,
        g,
        b,
    ));
    surface
        .canvas()
        .draw_str(text, (x as f32, y as f32), &font, &paint);

    let mut out = vec![0u8; info.min_row_bytes() * height as usize];
    let _ = surface.read_pixels(&info, &mut out, info.min_row_bytes(), (0, 0));
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

#[derive(serde::Deserialize)]
struct PatternArgs {
    width: u32,
    height: u32,
    #[serde(default)]
    fill: Option<Vec<f64>>,
    #[serde(default)]
    lines: Vec<Vec<f64>>,
    #[serde(default = "default_line_width")]
    line_width: f64,
    #[serde(default)]
    stroke: Option<Vec<f64>>,
    #[serde(default = "default_stroke_opacity")]
    stroke_opacity: f64,
}

fn default_line_width() -> f64 {
    1.0
}

fn default_stroke_opacity() -> f64 {
    1.0
}

/// Tile pattern for g-element rect+path fills: solid fill + stroked polylines,
/// antialiased by skia like the browser baseline. Returns straight-RGBA base64.
fn rasterize_pattern(args: &str) -> Result<String, String> {
    use base64::Engine as _;
    use skia_safe::{surfaces, AlphaType, ColorType, Paint, PaintStyle};
    let parsed: PatternArgs =
        serde_json::from_str(args).map_err(|error| format!("bad pattern args: {error}"))?;
    let width = parsed.width.max(1);
    let height = parsed.height.max(1);
    let info = skia_safe::ImageInfo::new(
        (width as i32, height as i32),
        ColorType::RGBA8888,
        AlphaType::Unpremul,
        None,
    );
    let mut surface =
        surfaces::raster(&info, None, None).ok_or_else(|| "failed to create surface".to_string())?;
    if let Some(fill) = &parsed.fill {
        let mut paint = Paint::default();
        paint.set_anti_alias(false);
        paint.set_color(pattern_color(fill, 1.0));
        surface.canvas().draw_rect(
            skia_safe::Rect::from_ltrb(0.0, 0.0, width as f32, height as f32),
            &paint,
        );
    }
    if let Some(stroke) = &parsed.stroke {
        let mut builder = skia_safe::PathBuilder::new();
        for line in &parsed.lines {
            if line.len() < 4 {
                continue;
            }
            // each segment is its own subpath — chaining would draw bogus connectors
            builder.move_to((line[0] as f32, line[1] as f32));
            builder.line_to((line[2] as f32, line[3] as f32));
        }
        let path = builder.detach();
        let mut paint = Paint::default();
        paint.set_anti_alias(true);
        paint.set_style(PaintStyle::Stroke);
        paint.set_stroke_width(parsed.line_width as f32);
        paint.set_color(pattern_color(stroke, parsed.stroke_opacity));
        surface.canvas().draw_path(&path, &paint);
    }
    let mut out = vec![0u8; info.min_row_bytes() * height as usize];
    let _ = surface.read_pixels(&info, &mut out, info.min_row_bytes(), (0, 0));
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

fn pattern_color(rgba: &[f64], extra_alpha: f64) -> skia_safe::Color {
    let channel = |i: usize| -> u8 { (rgba.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0) * 255.0).round() as u8 };
    let a = rgba
        .get(3)
        .copied()
        .unwrap_or(1.0)
        .clamp(0.0, 1.0)
        * extra_alpha.clamp(0.0, 1.0);
    skia_safe::Color::from_argb((a * 255.0).round() as u8, channel(0), channel(1), channel(2))
}

/// encoded image base64 (PNG/JPEG) -> JSON {width,height,rgba} straight RGBA.
fn image_rgba(encoded: &str) -> Result<String, String> {
    use base64::Engine as _;
    use skia_safe::{AlphaType, ColorType, ImageInfo};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("bad base64 image: {error}"))?;
    let image = crate::g2_canvas::decode_image_data(&bytes).ok_or("image decode failed")?;
    let (w, h) = (image.width(), image.height());
    let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
    let mut pix = vec![0u8; info.min_row_bytes() * h as usize];
    let ok = image.read_pixels(&info, &mut pix, info.min_row_bytes(), (0, 0), skia_safe::image::CachingHint::Allow);
    if !ok {
        return Err("read_pixels failed".into());
    }
    Ok(format!(
        "{{\"width\":{w},\"height\":{h},\"rgba\":\"{}\"}}",
        base64::engine::general_purpose::STANDARD.encode(pix)
    ))
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
    // Match browser canvas measureText: subpixel, un-hinted advances (Chrome/DirectWrite
    // natural widths). Without this, hinted integer advances measure ~3% narrower.
    font.set_subpixel(true);
    font.set_hinting(skia_safe::FontHinting::None);
    // ponytail: Chrome's fontBoundingBoxAscent uses the DWrite win metrics (14 for
    // 12px Segoe-ish), not the typo metrics (11) — linear metrics switches skia to
    // the typo set and G2's axis padding (label heights) drifts ~3px per row.
    font.set_linear_metrics(false);

    let (width, bounds) = font.measure_str(text, None);
    let (_, metrics) = font.metrics();

    // ponytail: Chrome quantizes the four bounding-box metrics to integers (width stays
    // fractional); rounding keeps G2's layout math pixel-identical to the browser.
    TextMeasure {
        width: width.max(0.0),
        actual_bounding_box_ascent: (-bounds.top).max(0.0).round(),
        actual_bounding_box_descent: bounds.bottom.max(0.0).round(),
        font_bounding_box_ascent: (-metrics.ascent).max(0.0).round(),
        font_bounding_box_descent: metrics.descent.max(0.0).round(),
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
        // ponytail: Chrome resolves generic families through its own fallback list
        // (e.g. sans-serif lands on Noto Sans on machines that have it, else Arial).
        // Mirror the common candidates so measurements match the browser.
        if let Some(candidates) = generic_candidates(family) {
            for candidate in candidates {
                if let Some(typeface) = font_mgr.match_family_style(candidate, style) {
                    return Some(typeface);
                }
            }
        }
        if let Some(typeface) = font_mgr.legacy_make_typeface(Some(family), style) {
            return Some(typeface);
        }
    }
    None
}

fn generic_candidates(family: &str) -> Option<&'static [&'static str]> {
    match family.to_ascii_lowercase().as_str() {
        // ponytail: headless Edge resolves sans-serif to the platform UI metric
        // family (Segoe UI on this machine); this order matched its measureText
        // to within 0.3px. Do NOT put Arial first — it drifts the other way.
        "sans-serif" | "sans serif" => {
            Some(&["Noto Sans SC", "Noto Sans", "Microsoft YaHei", "Arial", "Segoe UI"])
        }
        "serif" => Some(&["Times New Roman", "Noto Serif", "Georgia"]),
        "monospace" | "monospace ct" => Some(&["Consolas", "Courier New", "Noto Sans Mono"]),
        "system-ui" | "-apple-system" | "cursive" | "fantasy" => {
            Some(&["Segoe UI", "Arial"])
        }
        _ => None,
    }
}

#[cfg(test)]
mod font_tests {
    use super::*;
    #[test]
    fn list_noto_families() {
        let mgr = FontMgr::default();
        let names: Vec<String> = mgr.family_names().collect();
        let mut noto = Vec::new();
        let mut has_arial = false;
        for n in &names {
            let l = n.to_lowercase();
            if l.contains("noto") { noto.push(n.clone()); }
            if l.contains("arial") { has_arial = true; }
        }
        println!("total={}", names.len());
        println!("noto={:?} arial={}", noto, has_arial);
        let m = mgr.match_family_style("Noto Sans", FontStyle::normal());
        println!("match Noto Sans: {:?}", m.is_some());
        let m2 = mgr.match_family_style("Arial", FontStyle::normal());
        println!("match Arial: {:?}", m2.is_some());
    }
}
