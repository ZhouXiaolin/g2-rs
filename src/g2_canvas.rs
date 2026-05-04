use serde::Deserialize;
use serde_json::Value;
use skia_safe::{
    paint, path_builder, surfaces, Color, EncodedImageFormat, FontMgr, Matrix, Paint,
    PathBuilder, PathDirection, PathEffect, Point, RRect, Rect,
};
use skia_safe::textlayout::{FontCollection, ParagraphBuilder, ParagraphStyle, TextAlign, TextDirection, TextStyle};

#[derive(Debug, Clone, Deserialize)]
pub struct G2ScenePayload {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    #[serde(rename = "fakeCanvasKitCommands")]
    pub fake_canvas_kit_commands: Vec<G2CanvasCommand>,
}

#[derive(Debug, Clone)]
pub struct G2Scene {
    pub width: i32,
    pub height: i32,
    pub commands: Vec<G2CanvasCommand>,
}

#[derive(Debug)]
pub enum G2ReplayError {
    Json(String),
    Render(String),
}

impl std::fmt::Display for G2ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            G2ReplayError::Json(e) => write!(f, "JSON error: {e}"),
            G2ReplayError::Render(e) => write!(f, "Render error: {e}"),
        }
    }
}

impl std::error::Error for G2ReplayError {}

#[derive(Debug, Clone, Deserialize)]
pub struct PaintSnapshot {
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub color: Option<[f32; 4]>,
    #[serde(default)]
    #[serde(rename = "strokeWidth")]
    pub stroke_width: Option<f32>,
    #[serde(default)]
    #[serde(rename = "strokeCap")]
    pub stroke_cap: Option<String>,
    #[serde(default)]
    #[serde(rename = "strokeJoin")]
    pub stroke_join: Option<String>,
    #[serde(default)]
    #[serde(rename = "strokeMiter")]
    pub stroke_miter: Option<f32>,
    #[serde(default)]
    pub alpha: Option<f32>,
    #[serde(default)]
    #[serde(rename = "hasShader")]
    pub has_shader: bool,
    #[serde(default)]
    #[serde(rename = "hasPathEffect")]
    pub has_path_effect: bool,
    #[serde(default)]
    #[serde(rename = "hasMaskFilter")]
    pub has_mask_filter: bool,
    #[serde(default)]
    #[serde(rename = "pathEffect")]
    pub path_effect: Option<PathEffectSnapshot>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CommandMeta {
    #[serde(default)]
    pub source: Option<CommandSource>,
    #[serde(default)]
    #[serde(rename = "sourcePaints")]
    pub source_paints: Option<SourcePaintsSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CommandSource {
    Object(DisplayObjectSnapshot),
    Text(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SourcePaintsSnapshot {
    #[serde(default)]
    #[serde(rename = "fillPaint")]
    pub fill_paint: Option<PaintSnapshot>,
    #[serde(default)]
    #[serde(rename = "strokePaint")]
    pub stroke_paint: Option<PaintSnapshot>,
    #[serde(default)]
    #[serde(rename = "shadowFillPaint")]
    pub shadow_fill_paint: Option<PaintSnapshot>,
    #[serde(default)]
    #[serde(rename = "shadowStrokePaint")]
    pub shadow_stroke_paint: Option<PaintSnapshot>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DisplayObjectSnapshot {
    #[serde(default)]
    #[serde(rename = "nodeName")]
    pub node_name: Option<String>,
    #[serde(default)]
    #[serde(rename = "lineWidth")]
    pub line_width: Option<f32>,
    #[serde(default)]
    #[serde(rename = "lineCap")]
    pub line_cap: Option<String>,
    #[serde(default)]
    #[serde(rename = "lineJoin")]
    pub line_join: Option<String>,
    #[serde(default)]
    pub opacity: Option<f32>,
    #[serde(default)]
    #[serde(rename = "fillOpacity")]
    pub fill_opacity: Option<f32>,
    #[serde(default)]
    #[serde(rename = "strokeOpacity")]
    pub stroke_opacity: Option<f32>,
    #[serde(default)]
    pub stroke: Option<SourceColorSnapshot>,
    #[serde(default)]
    pub fill: Option<SourceColorSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SourceColorSnapshot {
    Object(SourceColorObject),
    Array([f32; 4]),
    Text(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SourceColorObject {
    #[serde(default)]
    pub r: Option<f32>,
    #[serde(default)]
    pub g: Option<f32>,
    #[serde(default)]
    pub b: Option<f32>,
    #[serde(default)]
    pub alpha: Option<f32>,
    #[serde(default)]
    #[serde(rename = "isNone")]
    pub is_none: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PathEffectSnapshot {
    pub kind: String,
    #[serde(default)]
    pub intervals: Vec<f32>,
    #[serde(default)]
    pub phase: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum G2CanvasCommand {
    #[serde(rename = "save")]
    Save,
    #[serde(rename = "restore")]
    Restore,
    #[serde(rename = "translate")]
    Translate { x: f32, y: f32 },
    #[serde(rename = "skew")]
    Skew { x: f32, y: f32 },
    #[serde(rename = "rotate")]
    Rotate { degrees: f32, #[serde(default)] cx: f32, #[serde(default)] cy: f32 },
    #[serde(rename = "scale")]
    Scale { x: f32, y: f32 },
    #[serde(rename = "concat")]
    Concat { matrix: Vec<f32> },
    #[serde(rename = "clear")]
    Clear { color: [f32; 4] },
    #[serde(rename = "clipPath")]
    ClipPath {
        #[serde(default)]
        path: Vec<Vec<Value>>,
        #[serde(default)]
        #[serde(rename = "clipOp")]
        clip_op: String,
        #[serde(default)]
        antialias: bool,
    },
    #[serde(rename = "drawRect")]
    DrawRect {
        #[serde(flatten)]
        meta: CommandMeta,
        rect: Vec<f32>,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawRRect")]
    DrawRRect {
        #[serde(flatten)]
        meta: CommandMeta,
        rrect: Vec<f32>,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawPath")]
    DrawPath {
        #[serde(flatten)]
        meta: CommandMeta,
        #[serde(default)]
        path: Vec<Vec<Value>>,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawLine")]
    DrawLine {
        #[serde(flatten)]
        meta: CommandMeta,
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawCircle")]
    DrawCircle {
        #[serde(flatten)]
        meta: CommandMeta,
        cx: f32,
        cy: f32,
        r: f32,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawOval")]
    DrawOval {
        #[serde(flatten)]
        meta: CommandMeta,
        rect: Vec<f32>,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawParagraph")]
    DrawParagraph {
        text: String,
        width: f32,
        x: f32,
        y: f32,
        #[serde(default = "default_font_size")]
        #[serde(rename = "fontSize")]
        font_size: f32,
        #[serde(default = "default_color")]
        color: [f32; 4],
        #[serde(default = "default_text_align")]
        #[serde(rename = "textAlign")]
        text_align: String,
        #[serde(default = "default_text_direction")]
        #[serde(rename = "textDirection")]
        text_direction: String,
        #[serde(default)]
        #[serde(rename = "maxLines")]
        max_lines: Option<usize>,
        #[serde(default)]
        ellipsis: Option<String>,
        #[serde(default)]
        #[serde(rename = "fontFamilies")]
        font_families: Vec<String>,
    },
    #[serde(rename = "drawTextBlob")]
    DrawTextBlob {
        #[serde(rename = "textBlob")]
        text_blob: Value,
        x: f32,
        y: f32,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "drawImageRectOptions")]
    DrawImageRectOptions {
        #[serde(default)]
        #[serde(rename = "srcRect")]
        src_rect: Vec<f32>,
        #[serde(default)]
        #[serde(rename = "dstRect")]
        dst_rect: Vec<f32>,
        paint: Option<PaintSnapshot>,
    },
    #[serde(rename = "flush")]
    Flush,
}

pub fn scene_from_json(json: &str) -> Result<G2Scene, G2ReplayError> {
    let payload: G2ScenePayload =
        serde_json::from_str(json).map_err(|e| G2ReplayError::Json(e.to_string()))?;
    Ok(G2Scene {
        width: payload.width as i32,
        height: payload.height as i32,
        commands: payload.fake_canvas_kit_commands,
    })
}

pub fn render_scene_to_png(scene: &G2Scene) -> Result<Vec<u8>, G2ReplayError> {
    let image = render_scene_to_image(scene)?;
    encode_png(&image)
}

fn render_scene_to_image(scene: &G2Scene) -> Result<skia_safe::Image, G2ReplayError> {
    let mut surface = surfaces::raster_n32_premul((scene.width, scene.height))
        .ok_or_else(|| G2ReplayError::Render("failed to create raster surface".into()))?;
    let mut text = TextRenderer::new();

    {
        let canvas = surface.canvas();
        for command in &scene.commands {
            replay_command(canvas, &mut text, command)?;
        }
    }

    Ok(surface.image_snapshot())
}

fn encode_png(image: &skia_safe::Image) -> Result<Vec<u8>, G2ReplayError> {
    let data = image
        .encode(None, EncodedImageFormat::PNG, None)
        .ok_or_else(|| G2ReplayError::Render("failed to encode PNG".into()))?;
    Ok(data.as_bytes().to_vec())
}

fn replay_command(
    canvas: &skia_safe::Canvas,
    text: &mut TextRenderer,
    command: &G2CanvasCommand,
) -> Result<(), G2ReplayError> {
    match command {
        G2CanvasCommand::Save => {
            canvas.save();
        }
        G2CanvasCommand::Restore => {
            canvas.restore();
        }
        G2CanvasCommand::Translate { x, y } => {
            canvas.translate((*x, *y));
        }
        G2CanvasCommand::Skew { x, y } => {
            canvas.skew((*x, *y));
        }
        G2CanvasCommand::Rotate { degrees, cx, cy } => {
            let pivot = if *cx == 0.0 && *cy == 0.0 {
                None
            } else {
                Some(Point::new(*cx, *cy))
            };
            canvas.rotate(*degrees, pivot);
        }
        G2CanvasCommand::Scale { x, y } => {
            canvas.scale((*x, *y));
        }
        G2CanvasCommand::Concat { matrix } => {
            if let Some(matrix) = matrix_from_slice(matrix) {
                canvas.concat(&matrix);
            }
        }
        G2CanvasCommand::Clear { color } => {
            canvas.clear(to_color4f(*color));
        }
        G2CanvasCommand::ClipPath { path, .. } => {
            if let Some(path) = build_path(path) {
                canvas.clip_path(&path, None, Some(true));
            }
        }
        G2CanvasCommand::DrawRect { meta, rect, paint } => {
            if let Some(rect) = to_rect(rect) {
                if let Some(paint) = resolve_paint(paint.as_ref(), Some(meta), PaintPreference::Auto)?
                {
                    canvas.draw_rect(rect, &paint);
                }
            }
        }
        G2CanvasCommand::DrawRRect { meta, rrect, paint } => {
            if let Some(rrect) = to_rrect(rrect) {
                if let Some(paint) = resolve_paint(paint.as_ref(), Some(meta), PaintPreference::Auto)?
                {
                    canvas.draw_rrect(&rrect, &paint);
                }
            }
        }
        G2CanvasCommand::DrawPath { meta, path, paint } => {
            if let Some(path) = build_path(path) {
                if let Some(paint) = resolve_paint(paint.as_ref(), Some(meta), PaintPreference::Auto)?
                {
                    canvas.draw_path(&path, &paint);
                }
            }
        }
        G2CanvasCommand::DrawLine {
            meta,
            x1,
            y1,
            x2,
            y2,
            paint,
        } => {
            if let Some(paint) = resolve_paint(paint.as_ref(), Some(meta), PaintPreference::Stroke)? {
                canvas.draw_line((*x1, *y1), (*x2, *y2), &paint);
            }
        }
        G2CanvasCommand::DrawCircle { meta, cx, cy, r, paint } => {
            if let Some(paint) = resolve_paint(paint.as_ref(), Some(meta), PaintPreference::Auto)? {
                    canvas.draw_circle((*cx, *cy), *r, &paint);
            }
        }
        G2CanvasCommand::DrawOval { meta, rect, paint } => {
            if let Some(rect) = to_rect(rect) {
                if let Some(paint) = resolve_paint(paint.as_ref(), Some(meta), PaintPreference::Auto)?
                {
                    canvas.draw_oval(rect, &paint);
                }
            }
        }
        G2CanvasCommand::DrawParagraph {
            text: value,
            width,
            x,
            y,
            font_size,
            color,
            text_align,
            text_direction,
            max_lines,
            ellipsis,
            font_families,
        } => {
            text.draw(
                canvas,
                value,
                *width,
                *x,
                *y,
                *font_size,
                *color,
                text_align,
                text_direction,
                *max_lines,
                ellipsis.as_deref(),
                font_families,
            )?;
        }
        G2CanvasCommand::DrawTextBlob { .. } => {}
        G2CanvasCommand::DrawImageRectOptions { .. } => {}
        G2CanvasCommand::Flush => {}
    }

    Ok(())
}

fn build_paint(snapshot: &PaintSnapshot) -> Result<Option<Paint>, G2ReplayError> {
    if snapshot.has_shader || snapshot.has_mask_filter {
        return Ok(None);
    }

    let style = snapshot.style.as_deref().unwrap_or("fill");
    let stroke_width = snapshot.stroke_width.unwrap_or(1.0).max(0.0);
    if style == "stroke" && stroke_width <= 0.0 {
        return Ok(None);
    }

    let mut color = match snapshot.color {
        Some(color) => color,
        None => return Ok(None),
    };

    if let Some(alpha) = snapshot.alpha {
        if alpha.is_finite() {
            color[3] *= alpha.clamp(0.0, 1.0);
        }
    }

    if color[3] <= 0.0 {
        return Ok(None);
    }

    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(to_color(color));
    paint.set_stroke_width(stroke_width);
    paint.set_stroke_miter(snapshot.stroke_miter.unwrap_or(4.0).max(0.0));
    paint.set_style(match style {
        "stroke" => paint::Style::Stroke,
        _ => paint::Style::Fill,
    });
    paint.set_stroke_cap(match snapshot.stroke_cap.as_deref().unwrap_or("butt") {
        "round" => paint::Cap::Round,
        "square" => paint::Cap::Square,
        _ => paint::Cap::Butt,
    });
    paint.set_stroke_join(match snapshot.stroke_join.as_deref().unwrap_or("miter") {
        "round" => paint::Join::Round,
        "bevel" => paint::Join::Bevel,
        _ => paint::Join::Miter,
    });
    if let Some(path_effect) = build_path_effect(snapshot)? {
        paint.set_path_effect(path_effect);
    }

    Ok(Some(paint))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaintPreference {
    Auto,
    Fill,
    Stroke,
}

fn resolve_paint(
    primary: Option<&PaintSnapshot>,
    meta: Option<&CommandMeta>,
    default_preference: PaintPreference,
) -> Result<Option<Paint>, G2ReplayError> {
    if let Some(primary) = primary {
        if let Some(paint) = build_paint(primary)? {
            return Ok(Some(paint));
        }
    }

    let preference = primary
        .and_then(|paint| infer_preference_from_snapshot(paint))
        .or_else(|| meta.and_then(infer_preference_from_meta))
        .unwrap_or(default_preference);

    if let Some(meta) = meta {
        for snapshot in fallback_paint_snapshots(meta, preference) {
            if let Some(paint) = build_paint(snapshot)? {
                return Ok(Some(paint));
            }
        }
        if let Some(snapshot) = source_style_paint_snapshot(meta, preference) {
            if let Some(paint) = build_paint(&snapshot)? {
                return Ok(Some(paint));
            }
        }
    }

    Ok(None)
}

fn infer_preference_from_snapshot(snapshot: &PaintSnapshot) -> Option<PaintPreference> {
    match snapshot.style.as_deref() {
        Some("fill") => Some(PaintPreference::Fill),
        Some("stroke") => Some(PaintPreference::Stroke),
        _ => None,
    }
}

fn infer_preference_from_meta(meta: &CommandMeta) -> Option<PaintPreference> {
    let paints = meta.source_paints.as_ref()?;
    match (
        paints.fill_paint.is_some(),
        paints.stroke_paint.is_some(),
    ) {
        (true, false) => Some(PaintPreference::Fill),
        (false, true) => Some(PaintPreference::Stroke),
        _ => None,
    }
}

fn fallback_paint_snapshots<'a>(
    meta: &'a CommandMeta,
    preference: PaintPreference,
) -> Vec<&'a PaintSnapshot> {
    let mut out = Vec::new();
    let Some(paints) = meta.source_paints.as_ref() else {
        return out;
    };

    match preference {
        PaintPreference::Fill => {
            if let Some(fill) = paints.fill_paint.as_ref() {
                out.push(fill);
            }
        }
        PaintPreference::Stroke => {
            if let Some(stroke) = paints.stroke_paint.as_ref() {
                out.push(stroke);
            }
        }
        PaintPreference::Auto => match (
            paints.fill_paint.as_ref(),
            paints.stroke_paint.as_ref(),
        ) {
            (Some(fill), None) => out.push(fill),
            (None, Some(stroke)) => out.push(stroke),
            _ => {}
        },
    }

    out
}

fn source_style_paint_snapshot(meta: &CommandMeta, preference: PaintPreference) -> Option<PaintSnapshot> {
    let source = match meta.source.as_ref()? {
        CommandSource::Object(source) => source,
        CommandSource::Text(_) => return None,
    };

    match preference {
        PaintPreference::Fill => source.fill_snapshot(),
        PaintPreference::Stroke => source.stroke_snapshot(),
        PaintPreference::Auto => match (source.fill_snapshot(), source.stroke_snapshot()) {
            (Some(fill), None) => Some(fill),
            (None, Some(stroke)) => Some(stroke),
            _ => None,
        },
    }
}

fn build_path_effect(snapshot: &PaintSnapshot) -> Result<Option<PathEffect>, G2ReplayError> {
    let Some(path_effect) = snapshot.path_effect.as_ref() else {
        return Ok(None);
    };

    match path_effect.kind.as_str() {
        "dash" => {
            let intervals: Vec<f32> = path_effect
                .intervals
                .iter()
                .copied()
                .filter(|value| value.is_finite() && *value > 0.0)
                .collect();
            if intervals.len() < 2 {
                return Ok(None);
            }
            Ok(PathEffect::dash(&intervals, path_effect.phase))
        }
        _ => Ok(None),
    }
}

fn build_path(ops: &[Vec<Value>]) -> Option<skia_safe::Path> {
    let mut builder = PathBuilder::new();
    for op in ops {
        let verb = op.first()?.as_str()?;
        match verb {
            "moveTo" => {
                builder.move_to((value_at(op, 1), value_at(op, 2)));
            }
            "lineTo" => {
                builder.line_to((value_at(op, 1), value_at(op, 2)));
            }
            "quadTo" => {
                builder.quad_to(
                (value_at(op, 1), value_at(op, 2)),
                (value_at(op, 3), value_at(op, 4)),
                );
            }
            "cubicTo" => {
                builder.cubic_to(
                (value_at(op, 1), value_at(op, 2)),
                (value_at(op, 3), value_at(op, 4)),
                (value_at(op, 5), value_at(op, 6)),
                );
            }
            "arcToRotated" => {
                builder.arc_to_radius(
                    (value_at(op, 1), value_at(op, 2)),
                    value_at(op, 3),
                    if bool_at(op, 4) {
                        path_builder::ArcSize::Small
                    } else {
                        path_builder::ArcSize::Large
                    },
                    if bool_at(op, 5) {
                        PathDirection::CCW
                    } else {
                        PathDirection::CW
                    },
                    (value_at(op, 6), value_at(op, 7)),
                );
            }
            "addPoly" => {
                if let Some(points) = points_at(op, 1) {
                    builder.add_polygon(&points, bool_at(op, 2));
                }
            }
            "addRRect" => {
                if let Some(rrect) = rrect_at(op, 1) {
                    builder.add_rrect(&rrect, None, None);
                }
            }
            "transform" => {
                if let Some(matrix) = value_at_matrix(op, 1) {
                    builder.transform(&matrix);
                }
            }
            "close" => {
                builder.close();
            }
            _ => {}
        }
    }
    Some(builder.detach())
}

fn value_at(op: &[Value], index: usize) -> f32 {
    op.get(index)
        .and_then(Value::as_f64)
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn bool_at(op: &[Value], index: usize) -> bool {
    op.get(index).and_then(Value::as_bool).unwrap_or(false)
}

fn points_at(op: &[Value], index: usize) -> Option<Vec<Point>> {
    let values = op.get(index)?.as_array()?;
    let mut points = Vec::with_capacity(values.len());
    for value in values {
        let xy = value.as_array()?;
        let x = xy.first().and_then(Value::as_f64)? as f32;
        let y = xy.get(1).and_then(Value::as_f64)? as f32;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        points.push(Point::new(x, y));
    }
    Some(points)
}

fn rrect_at(op: &[Value], index: usize) -> Option<RRect> {
    let value = op.get(index)?.as_object()?;
    let rect = to_rect_value(value.get("rect")?)?;
    let rx = value
        .get("rx")
        .and_then(Value::as_f64)
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or_default()
        .abs();
    let ry = value
        .get("ry")
        .and_then(Value::as_f64)
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or_default()
        .abs();
    Some(RRect::new_rect_xy(rect, rx, ry))
}

fn value_at_matrix(op: &[Value], index: usize) -> Option<Matrix> {
    matrix_from_value(op.get(index)?)
}

fn to_rect(values: &[f32]) -> Option<Rect> {
    if values.len() < 4 {
        return None;
    }
    Some(Rect::from_ltrb(values[0], values[1], values[2], values[3]))
}

fn to_rect_value(value: &Value) -> Option<Rect> {
    let values = value.as_array()?;
    if values.len() < 4 {
        return None;
    }
    Some(Rect::from_ltrb(
        values[0].as_f64()? as f32,
        values[1].as_f64()? as f32,
        values[2].as_f64()? as f32,
        values[3].as_f64()? as f32,
    ))
}

fn to_rrect(values: &[f32]) -> Option<RRect> {
    let rect = to_rect(values)?;
    let rx = values.get(4).copied().unwrap_or_default().abs();
    let ry = values.get(5).copied().unwrap_or_default().abs();
    Some(RRect::new_rect_xy(rect, rx, ry))
}

fn to_color(color: [f32; 4]) -> Color {
    let [r, g, b, a] = normalized_color(color);
    Color::from_argb(
        (a * 255.0).round() as u8,
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    )
}

fn to_color4f(color: [f32; 4]) -> skia_safe::Color4f {
    let [r, g, b, a] = normalized_color(color);
    skia_safe::Color4f::new(r, g, b, a)
}

fn normalized_color(color: [f32; 4]) -> [f32; 4] {
    [
        color[0].clamp(0.0, 1.0),
        color[1].clamp(0.0, 1.0),
        color[2].clamp(0.0, 1.0),
        color[3].clamp(0.0, 1.0),
    ]
}

fn matrix_from_slice(values: &[f32]) -> Option<Matrix> {
    match values {
        [a, b, c, d, e, f] => Some(Matrix::new_all(*a, *c, *e, *b, *d, *f, 0.0, 0.0, 1.0)),
        [a, b, c, d, e, f, g, h, i, ..] => {
            Some(Matrix::new_all(*a, *b, *c, *d, *e, *f, *g, *h, *i))
        }
        _ => None,
    }
}

fn matrix_from_value(value: &Value) -> Option<Matrix> {
    let array = value.as_array()?;
    let values: Vec<f32> = array
        .iter()
        .filter_map(|value| value.as_f64())
        .map(|value| value as f32)
        .collect();
    if values.len() != array.len() {
        return None;
    }
    matrix_from_slice(&values)
}

struct TextRenderer;

impl TextRenderer {
    fn new() -> Self {
        Self
    }

    fn draw(
        &mut self,
        canvas: &skia_safe::Canvas,
        text: &str,
        width: f32,
        x: f32,
        y: f32,
        font_size: f32,
        color: [f32; 4],
        text_align: &str,
        text_direction: &str,
        max_lines: Option<usize>,
        ellipsis: Option<&str>,
        font_families: &[String],
    ) -> Result<(), G2ReplayError> {
        if text.is_empty() {
            return Ok(());
        }

        let mut font_collection = FontCollection::new();
        font_collection.set_default_font_manager(FontMgr::default(), None);

        let mut text_style = TextStyle::new();
        text_style.set_font_size(font_size.max(1.0));
        text_style.set_color(to_color(color));
        if !font_families.is_empty() {
            text_style.set_font_families(font_families);
        }

        let mut paragraph_style = ParagraphStyle::new();
        paragraph_style.set_text_style(&text_style);
        paragraph_style.set_text_direction(match text_direction {
            "rtl" => TextDirection::RTL,
            _ => TextDirection::LTR,
        });
        paragraph_style.set_text_align(match text_align {
            "center" | "middle" => TextAlign::Center,
            "right" | "end" => TextAlign::Right,
            _ => TextAlign::Left,
        });
        if let Some(max_lines) = max_lines.filter(|value| *value > 0) {
            paragraph_style.set_max_lines(Some(max_lines));
        }
        if let Some(ellipsis) = ellipsis.filter(|value| !value.is_empty()) {
            paragraph_style.set_ellipsis(ellipsis);
        }

        let mut builder = ParagraphBuilder::new(&paragraph_style, font_collection);
        builder.push_style(&text_style);
        builder.add_text(text);
        let mut paragraph = builder.build();
        paragraph.layout(width.max(1.0));
        paragraph.paint(canvas, Point::new(x, y));
        Ok(())
    }
}

fn default_color() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

fn default_font_size() -> f32 {
    12.0
}

fn default_text_align() -> String {
    "left".into()
}

fn default_text_direction() -> String {
    "ltr".into()
}

impl DisplayObjectSnapshot {
    fn fill_snapshot(&self) -> Option<PaintSnapshot> {
        let color = source_color_to_rgba(self.fill.as_ref()?)?;
        let opacity = self.opacity.unwrap_or(1.0).clamp(0.0, 1.0);
        let fill_opacity = self.fill_opacity.unwrap_or(1.0).clamp(0.0, 1.0);
        let alpha = color[3] * opacity * fill_opacity;
        if alpha <= 0.0 {
            return None;
        }

        Some(PaintSnapshot {
            style: Some("fill".into()),
            color: Some([color[0], color[1], color[2], alpha]),
            stroke_width: None,
            stroke_cap: None,
            stroke_join: self.line_join.clone(),
            stroke_miter: None,
            alpha: None,
            has_shader: false,
            has_path_effect: false,
            has_mask_filter: false,
            path_effect: None,
        })
    }

    fn stroke_snapshot(&self) -> Option<PaintSnapshot> {
        let color = source_color_to_rgba(self.stroke.as_ref()?)?;
        let stroke_width = self.line_width.unwrap_or(1.0).max(0.0);
        if stroke_width <= 0.0 {
            return None;
        }

        let opacity = self.opacity.unwrap_or(1.0).clamp(0.0, 1.0);
        let stroke_opacity = self.stroke_opacity.unwrap_or(1.0).clamp(0.0, 1.0);
        let alpha = color[3] * opacity * stroke_opacity;
        if alpha <= 0.0 {
            return None;
        }

        Some(PaintSnapshot {
            style: Some("stroke".into()),
            color: Some([color[0], color[1], color[2], alpha]),
            stroke_width: Some(stroke_width),
            stroke_cap: self.line_cap.clone(),
            stroke_join: self.line_join.clone(),
            stroke_miter: None,
            alpha: None,
            has_shader: false,
            has_path_effect: false,
            has_mask_filter: false,
            path_effect: None,
        })
    }
}

fn source_color_to_rgba(source: &SourceColorSnapshot) -> Option<[f32; 4]> {
    match source {
        SourceColorSnapshot::Object(color) => {
            if color.is_none.unwrap_or(false) {
                return None;
            }
            let r = color.r?.clamp(0.0, 255.0) / 255.0;
            let g = color.g?.clamp(0.0, 255.0) / 255.0;
            let b = color.b?.clamp(0.0, 255.0) / 255.0;
            let a = color.alpha.unwrap_or(1.0).clamp(0.0, 1.0);
            Some([r, g, b, a])
        }
        SourceColorSnapshot::Array(color) => Some(normalized_color(*color)),
        SourceColorSnapshot::Text(text) => parse_named_source_color(text),
    }
}

fn parse_named_source_color(text: &str) -> Option<[f32; 4]> {
    let value = text.trim().to_ascii_lowercase();
    match value.as_str() {
        "" | "none" | "transparent" => None,
        "black" => Some([0.0, 0.0, 0.0, 1.0]),
        "white" => Some([1.0, 1.0, 1.0, 1.0]),
        _ => None,
    }
}
