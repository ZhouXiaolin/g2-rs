use resvg::tiny_skia;
use resvg::usvg;
use rquickjs::{Context, FromJs, Runtime};

const MATHJAX_BUNDLE: &str = include_str!("../js/mathjax-bundle.js");

mod g2;
mod g2_canvas;

pub use g2::{G2Probe, G2ProbeError, G2ProbeReport, G2RunOptions, ProbeLog};
pub use g2_canvas::{
    render_scene_to_png, scene_from_json, G2CanvasCommand, G2ReplayError, G2Scene, G2ScenePayload,
};

pub struct MathRenderer {
    #[allow(dead_code)]
    runtime: Runtime,
    context: Context,
}

#[derive(Debug)]
pub enum RenderError {
    Js(String),
    SvgParse(String),
    Render(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::Js(e) => write!(f, "JS error: {e}"),
            RenderError::SvgParse(e) => write!(f, "SVG parse error: {e}"),
            RenderError::Render(e) => write!(f, "Render error: {e}"),
        }
    }
}

impl std::error::Error for RenderError {}

impl MathRenderer {
    pub fn new() -> Result<Self, RenderError> {
        let runtime = Runtime::new().map_err(|e| RenderError::Js(e.to_string()))?;
        runtime.set_max_stack_size(4 * 1024 * 1024);
        let context = Context::full(&runtime).map_err(|e| RenderError::Js(e.to_string()))?;
        context.with(|ctx| {
            ctx.eval::<(), _>(MATHJAX_BUNDLE)
                .map_err(|e| RenderError::Js(format!("{e:?}")))?;
            Ok::<(), RenderError>(())
        })?;
        Ok(Self {
            runtime,
            context,
        })
    }

    pub fn tex_to_svg(&self, latex: &str, display: bool) -> Result<String, RenderError> {
        let latex_owned = latex.to_owned();
        let display_str = if display { "true" } else { "false" };
        self.context.with(|ctx| {
            let js_code = format!(
                "texToSVG({}, {})",
                json_escape(&latex_owned),
                display_str
            );
            match ctx.eval::<String, _>(js_code.as_str()) {
                Ok(svg) => Ok(svg),
                Err(rquickjs::Error::Exception) => {
                    let ex = ctx.catch();
                    let msg = String::from_js(&ctx, ex).unwrap_or_default();
                    Err(RenderError::Js(msg))
                }
                Err(e) => Err(RenderError::Js(e.to_string())),
            }
        })
    }

    pub fn tex_to_png(
        &self,
        latex: &str,
        display: bool,
        scale: f32,
    ) -> Result<Vec<u8>, RenderError> {
        let svg_str = self.tex_to_svg(latex, display)?;
        svg_to_png(&svg_str, scale)
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn svg_to_png(svg_str: &str, scale: f32) -> Result<Vec<u8>, RenderError> {
    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg_str, &opt)
        .map_err(|e| RenderError::SvgParse(e.to_string()))?;

    let size = tree.size();
    let w = (size.width() * scale).ceil() as u32;
    let h = (size.height() * scale).ceil() as u32;

    let mut pixmap = tiny_skia::Pixmap::new(w, h)
        .ok_or_else(|| RenderError::Render("failed to create pixmap".into()))?;

    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    pixmap
        .encode_png()
        .map_err(|e| RenderError::Render(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tex_to_svg() {
        let renderer = MathRenderer::new().unwrap();
        let svg = renderer.tex_to_svg("x^2", true).unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("</svg>"));
    }

    #[test]
    fn test_tex_to_png() {
        let renderer = MathRenderer::new().unwrap();
        let png = renderer.tex_to_png("E = mc^2", true, 2.0).unwrap();
        assert!(png.starts_with(&[0x89, 0x50, 0x4E, 0x47]));
    }
}
