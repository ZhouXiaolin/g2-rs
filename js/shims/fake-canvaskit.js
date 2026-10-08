function hostLog(level, message, extra) {
  const suffix =
    extra === undefined
      ? ""
      : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  if (typeof globalThis.__rust_log === "function") {
    globalThis.__rust_log(String(level), `${String(message)}${suffix}`);
  }
}

const trace = [];
let nextId = 1;
const MAX_TRACE = 2000;
const MAX_COMMANDS = 200000;

function cloneTaggedValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => cloneTaggedValue(item, depth + 1, seen));
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    out[key] = cloneTaggedValue(item, depth + 1, seen);
  }
  return out;
}

function snapshotCurrentSource() {
  const source = globalThis.__fakeCanvasKitCurrentObject;
  if (!source || typeof source !== "object") return null;
  return cloneTaggedValue(source);
}

function snapshotCurrentPaints() {
  const paints = globalThis.__fakeCanvasKitCurrentPaints;
  if (!paints || typeof paints !== "object") return null;
  return cloneTaggedValue(paints);
}

function record(name, args) {
  const entry = {
    index: trace.length,
    name,
    args: Array.from(args || []).map((value) => serializeArg(value)),
  };
  if (trace.length < MAX_TRACE) trace.push(entry);
  return entry;
}

// One layer per CanvasKit surface (i.e. per chart canvas). Multi-chart demos
// render several stacked canvases; the probe computes their page offsets and
// the replay composites layers at those offsets.
const layers = [];
let activeLayer = null;

function ensureLayer() {
  if (activeLayer) return activeLayer;
  const layer = {
    index: layers.length,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    canvas: null,
    commands: [],
  };
  layers.push(layer);
  activeLayer = layer;
  return layer;
}

function recordCommand(kind, payload = {}) {
  const layer = ensureLayer();
  const commands = layer.commands;
  if (kind === "clear") {
    // ponytail: endFrame starts with canvas.clear, so treat clear as a frame boundary;
    // commands then reflect the LAST complete frame, matching what a real canvas shows.
    commands.length = 0;
  }
  const entry = {
    index: commands.length,
    kind,
    source: snapshotCurrentSource(),
    sourcePaints: snapshotCurrentPaints(),
    ...payload,
  };
  if (commands.length < MAX_COMMANDS) commands.push(entry);
  return entry;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;

  const r = finiteOptionalNumber(value[0]);
  const g = finiteOptionalNumber(value[1]);
  const b = finiteOptionalNumber(value[2]);
  if (r === null || g === null || b === null) return null;

  return [r, g, b, finiteNumber(value[3], 1)];
}

function parseHexColor(input) {
  const hex = String(input).trim().toLowerCase();
  if (!hex.startsWith("#")) return null;

  if (hex.length === 4 || hex.length === 5) {
    const r = parseInt(hex[1] + hex[1], 16);
    const g = parseInt(hex[2] + hex[2], 16);
    const b = parseInt(hex[3] + hex[3], 16);
    const a = hex.length === 5 ? parseInt(hex[4] + hex[4], 16) / 255 : 1;
    return [r / 255, g / 255, b / 255, a];
  }

  if (hex.length === 7 || hex.length === 9) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
    return [r / 255, g / 255, b / 255, a];
  }

  return null;
}

function parseRgbColor(input) {
  const text = String(input).trim().toLowerCase();
  const match = text.match(/^rgba?\((.+)\)$/);
  if (!match) return null;

  const parts = match[1].split(",").map((part) => part.trim());
  if (parts.length < 3) return null;

  const parseChannel = (part) => {
    if (part.endsWith("%")) {
      return finiteNumber(parseFloat(part) / 100, 0);
    }
    return finiteNumber(parseFloat(part) / 255, 0);
  };

  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  const a = parts[3] === undefined ? 1 : finiteNumber(parseFloat(parts[3]), 1);
  return [r, g, b, a];
}

const NAMED_COLORS = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  green: [0, 0.5, 0, 1],
  blue: [0, 0, 1, 1],
  yellow: [1, 1, 0, 1],
  cyan: [0, 1, 1, 1],
  magenta: [1, 0, 1, 1],
  grey: [0.5, 0.5, 0.5, 1],
  gray: [0.5, 0.5, 0.5, 1],
};

function parseColorString(value) {
  if (Array.isArray(value)) return normalizeColor(value);
  if (typeof value !== "string") return null;

  const text = value.trim().toLowerCase();
  return parseHexColor(text) || parseRgbColor(text) || NAMED_COLORS[text] || null;
}

function toBase64(bytes) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : chars[b2 & 63];
  }
  return out;
}

function flattenColorArray(colors) {
  const flat = Array.from(colors || []);
  // g-canvaskit's radial path passes per-stop arrays ([Float32Array(4), ...]);
  // the linear path passes a flat [r,g,b,a,...]. Normalize both.
  const nested =
    flat.length > 0 &&
    flat.every((item) => item && typeof item === "object" && typeof item.length === "number");
  const out = [];
  if (nested) {
    for (const stop of flat) {
      const c = Array.from(stop).map((v) => finiteNumber(v));
      out.push(normalizeColor(c) || [0, 0, 0, 1]);
    }
    return out;
  }
  for (let i = 0; i + 3 < flat.length; i += 4) {
    out.push(normalizeColor(flat.slice(i, i + 4)) || [0, 0, 0, 1]);
  }
  return out;
}

function snapshotShader(shader) {
  if (!shader || typeof shader !== "object") return null;
  const state = shader.state || {};
  if (state.kind === "image") {
    return {
      kind: "image",
      rgba: state.rgba || null,
      width: finiteNumber(state.width),
      height: finiteNumber(state.height),
      matrix: Array.isArray(state.matrix) ? state.matrix.map((v) => finiteNumber(v)) : [1, 0, 0, 0, 1, 0, 0, 0, 1],
    };
  }
  if (state.kind !== "linear" && state.kind !== "radial") return null;
  const out = { kind: state.kind, colors: state.colors || [], positions: state.positions || [] };
  if (state.kind === "linear") {
    out.start = state.start || [0, 0];
    out.end = state.end || [0, 0];
  } else {
    out.center = state.center || [0, 0];
    out.radius = finiteNumber(state.radius);
  }
  return out;
}

function snapshotPaint(paint) {
  if (!paint || typeof paint !== "object") return null;
  const state = paint.state || {};
  if (Object.keys(state).length === 0) return null;

  return {
    style: typeof state.style === "string" ? state.style : null,
    color: normalizeColor(state.color),
    strokeWidth: finiteOptionalNumber(state.strokeWidth),
    strokeCap: typeof state.strokeCap === "string" ? state.strokeCap : null,
    strokeJoin: typeof state.strokeJoin === "string" ? state.strokeJoin : null,
    strokeMiter: finiteOptionalNumber(state.strokeMiter),
    alpha: finiteOptionalNumber(state.alpha),
    shader: snapshotShader(state.shader),
    hasShader: state.shader !== undefined,
    hasPathEffect: state.pathEffect !== undefined,
    hasMaskFilter: state.maskFilter !== undefined,
    maskFilter: snapshotMaskFilter(state.maskFilter),
    pathEffect: snapshotPathEffect(state.pathEffect),
  };
}

function snapshotMaskFilter(maskFilter) {
  if (!maskFilter || typeof maskFilter !== "object") return null;
  const state = maskFilter.state || {};
  if (state.kind !== "blur") return null;
  return { kind: "blur", sigma: finiteNumber(state.sigma) };
}

function snapshotPathEffect(pathEffect) {
  if (!pathEffect || typeof pathEffect !== "object") return null;
  const state = pathEffect.state || {};
  if (state.kind === "dash") {
    return {
      kind: "dash",
      intervals: Array.isArray(state.intervals)
        ? state.intervals.map((value) => finiteNumber(value, 0))
        : [],
      phase: finiteNumber(state.phase, 0),
    };
  }
  return null;
}

function snapshotPath(path) {
  if (!path || typeof path !== "object") return [];
  return Array.isArray(path.ops) ? path.ops.map((op) => op.map(snapshotPathValue)) : [];
}

function approxEqual(a, b, epsilon = 0.01) {
  return Math.abs(finiteNumber(a) - finiteNumber(b)) <= epsilon;
}

function parseTranslateMatrix(matrix) {
  if (!Array.isArray(matrix)) return null;
  if (
    matrix.length >= 6 &&
    approxEqual(matrix[0], 1) &&
    approxEqual(matrix[1], 0) &&
    approxEqual(matrix[2], 0) &&
    approxEqual(matrix[3], 1)
  ) {
    return {
      tx: finiteNumber(matrix[4]),
      ty: finiteNumber(matrix[5]),
    };
  }

  if (
    matrix.length >= 9 &&
    approxEqual(matrix[0], 1) &&
    approxEqual(matrix[1], 0) &&
    approxEqual(matrix[3], 0) &&
    approxEqual(matrix[4], 1) &&
    approxEqual(matrix[6], 0) &&
    approxEqual(matrix[7], 0) &&
    approxEqual(matrix[8], 1)
  ) {
    return {
      tx: finiteNumber(matrix[2]),
      ty: finiteNumber(matrix[5]),
    };
  }

  return null;
}

function getPathBounds(ops) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visitPoint = (x, y) => {
    const px = finiteOptionalNumber(x);
    const py = finiteOptionalNumber(y);
    if (px === null || py === null) return;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  };

  for (const op of ops || []) {
    const verb = op?.[0];
    switch (verb) {
      case "moveTo":
      case "lineTo":
        visitPoint(op[1], op[2]);
        break;
      case "quadTo":
        visitPoint(op[1], op[2]);
        visitPoint(op[3], op[4]);
        break;
      case "cubicTo":
        visitPoint(op[1], op[2]);
        visitPoint(op[3], op[4]);
        visitPoint(op[5], op[6]);
        break;
      case "arcToRotated":
        visitPoint(op[6], op[7]);
        break;
      case "addPoly":
        for (const point of Array.isArray(op[1]) ? op[1] : []) {
          visitPoint(point?.[0], point?.[1]);
        }
        break;
      case "addRRect": {
        const rect = op[1]?.rect;
        if (Array.isArray(rect) && rect.length >= 4) {
          visitPoint(rect[0], rect[1]);
          visitPoint(rect[2], rect[3]);
        }
        break;
      }
      default:
        break;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

function shouldSkipDuplicatePathTranslate(ops, matrix) {
  const translate = parseTranslateMatrix(matrix);
  if (!translate) return false;

  const bounds = getPathBounds(ops);
  if (!bounds) return false;

  const hasAbsoluteOffset =
    Math.abs(bounds.minX) > 0.01 || Math.abs(bounds.minY) > 0.01;

  return (
    hasAbsoluteOffset &&
    approxEqual(bounds.minX, translate.tx) &&
    approxEqual(bounds.minY, translate.ty)
  );
}

function snapshotParagraph(paragraph, x, y) {
  if (!paragraph || typeof paragraph !== "object") return null;
  const textStyle = paragraph.textStyle || {};
  const paragraphStyle = paragraph.paragraphStyle || {};
  const sourceLayout = paragraph.sourceLayout || {};
  const maxWidth = finiteNumber(paragraph.getMaxWidth(), finiteNumber(paragraph.width, 0));
  const height = finiteNumber(paragraph.getHeight(), finiteNumber(textStyle.fontSize, 12));
  const textAlign = paragraphStyle.textAlign || textStyle.textAlign || "left";
  return {
    text: String(paragraph.text || ""),
    width: finiteNumber(paragraph.width, 0),
    x:
      finiteOptionalNumber(x) ??
      computeParagraphX(textAlign, maxWidth, sourceLayout),
    y:
      finiteOptionalNumber(y) ??
      computeParagraphY(sourceLayout.textBaseline, height, sourceLayout),
    fontSize: finiteNumber(textStyle.fontSize, 12),
    color: normalizeColor(textStyle.color),
    textAlign,
    textDirection: paragraphStyle.textDirection || "ltr",
    maxLines: finiteOptionalNumber(paragraphStyle.maxLines),
    ellipsis:
      typeof paragraphStyle.ellipsis === "string" ? paragraphStyle.ellipsis : null,
    fontFamilies: Array.isArray(textStyle.fontFamilies)
      ? textStyle.fontFamilies.map(String)
      : [],
  };
}

function snapshotPathValue(value) {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, 0);
  if (Array.isArray(value)) return value.map(snapshotPathValue);
  if (!value || typeof value !== "object") return null;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = snapshotPathValue(item);
  }
  return out;
}

function computeParagraphX(textAlign, maxWidth, sourceLayout) {
  let x = finiteNumber(sourceLayout.x, 0) + finiteNumber(sourceLayout.dx, 0);
  if (textAlign === "center" || textAlign === "middle") {
    x -= maxWidth / 2;
  } else if (textAlign === "right" || textAlign === "end") {
    x -= maxWidth;
  }
  return x;
}

function computeParagraphY(textBaseline, height, sourceLayout) {
  let y = finiteNumber(sourceLayout.y, 0) + finiteNumber(sourceLayout.dy, 0);
  if (textBaseline === "middle") {
    y -= height / 2;
  } else if (
    textBaseline === "bottom" ||
    textBaseline === "alphabetic" ||
    textBaseline === "ideographic"
  ) {
    y -= height;
  }
  return y;
}

function getTextMeasureContext() {
  if (globalThis.__fakeCanvasKitMeasureContext) {
    return globalThis.__fakeCanvasKitMeasureContext;
  }

  const canvas =
    typeof document !== "undefined" && document?.createElement
      ? document.createElement("canvas")
      : null;
  const context = canvas?.getContext?.("2d") || null;
  globalThis.__fakeCanvasKitMeasureContext = context;
  return context;
}

function buildTextMeasureFont(textStyle) {
  const fontSize = finiteNumber(textStyle?.fontSize, 12);
  const fontFamilies = Array.isArray(textStyle?.fontFamilies) && textStyle.fontFamilies.length > 0
    ? textStyle.fontFamilies.join(", ")
    : "sans-serif";
  const weight = textStyle?.fontStyle?.weight?.value ?? textStyle?.fontWeight ?? "normal";
  return `${weight} ${fontSize}px ${fontFamilies}`;
}

function measureParagraph(text, textStyle, paragraphStyle, width) {
  const context = getTextMeasureContext();
  const fontSize = finiteNumber(textStyle?.fontSize, 12);
  const lineHeight = fontSize;
  const measuredText = String(text || "");
  let measuredWidth = measuredText.length * fontSize * 0.6;
  let ascent = fontSize * 0.8;
  let descent = fontSize * 0.2;

  if (context) {
    context.font = buildTextMeasureFont(textStyle);
    const metrics = context.measureText(measuredText);
    measuredWidth = finiteNumber(metrics?.width, measuredWidth);
    // Real canvaskit Paragraph.getHeight() derives from font metrics, not glyph ink
    // bounds — using actualBoundingBox made labels sit several px off vs the browser.
    ascent = finiteNumber(metrics?.fontBoundingBoxAscent, ascent);
    descent = finiteNumber(metrics?.fontBoundingBoxDescent, descent);
  }

  const layoutWidth = finiteOptionalNumber(width);
  const maxLines = finiteOptionalNumber(paragraphStyle?.maxLines);
  let lines = 1;
  let maxWidth = measuredWidth;

  if (layoutWidth !== null && layoutWidth > 0) {
    if (maxLines === 1) {
      maxWidth = layoutWidth;
    } else if (measuredWidth > layoutWidth) {
      lines = Math.max(1, Math.ceil(measuredWidth / layoutWidth));
      if (maxLines !== null && maxLines > 0) {
        lines = Math.min(lines, maxLines);
      }
      maxWidth = layoutWidth;
    }
  }

  const height = (ascent + descent || lineHeight) * lines;
  return { maxWidth, height };
}

function serializeArg(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (depth >= 2) return `[${Object.prototype.toString.call(value)}]`;
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => serializeArg(v, depth + 1, seen));
  if (typeof value === "object") {
    if (value.__fakeId) return `${value.__fakeType}(${value.__fakeId})`;
    if (value.tagName) return `<${value.tagName}>`;
    if (value.nodeName) return `<${value.nodeName}>`;
    if (value instanceof ArrayBuffer) return `[ArrayBuffer byteLength=${value.byteLength}]`;
    if (ArrayBuffer.isView(value)) {
      return `[${value.constructor.name} length=${value.length}]`;
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).slice(0, 12)) {
      out[key] = serializeArg(value[key], depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function makeId(prefix) {
  return `${prefix}-${nextId++}`;
}

function defineFake(target, type) {
  Object.defineProperty(target, "__fakeId", {
    value: makeId(type),
    enumerable: false,
  });
  Object.defineProperty(target, "__fakeType", {
    value: type,
    enumerable: false,
  });
  return target;
}

function makeImageShaderFromState(state, matrix) {
  // ponytail: the g-canvas baseline caches one CanvasPattern per element, so the
  // tile phase comes from the FIRST shape's bounds min and is shared by the rest.
  // Mirror that with a first-seen phase cache keyed by the pattern element.
  const m = Array.from(matrix || [1, 0, 0, 0, 1, 0, 0, 0, 1]).map((v) => finiteNumber(v));
  const key = state.pattern_key || "pattern";
  const cache = (globalThis.__patternPhaseCache = globalThis.__patternPhaseCache || {});
  if (!cache[key]) cache[key] = [m[2], m[5]];
  m[2] = cache[key][0];
  m[5] = cache[key][1];
  return makeNoopObject("Shader", {
    state: {
      kind: "image",
      rgba: state.rgba || null,
      encoded: state.encoded || null,
      width: finiteNumber(state.width),
      height: finiteNumber(state.height),
      matrix: m,
    },
  });
}

function makeTextureImage(state) {
  return makeNoopObject("Image", {
    state,
    makeShaderOptions(tx, ty, fx, fy, matrix) {
      return makeImageShaderFromState(state, matrix);
    },
    makeShaderCubic(tx, ty, B, C, matrix) {
      return makeImageShaderFromState(state, matrix);
    },
  });
}

// g-canvaskit skips rect-shaped G-element patterns (empty branch); rasterize them
// here so pattern fills render like the g-canvas baseline.
globalThis.__renderRectPattern = function (el) {
  try {
    const style = el.style || {};
    const fill = styleColorValue(style.fill);
    const children = el.childNodes || [];
    hostLog("debug", "[pattern.rect] nodeName=" + el.nodeName + " children=" + children.length + " w=" + JSON.stringify(el.style && el.style.width) + " childNames=" + JSON.stringify((children || []).map((c) => c && c.nodeName)));
    let lines = [];
    let lineWidth = 1;
    let stroke = null;
    let strokeOpacity = 1;
    for (const child of children) {
      if (!child || child.nodeName !== "path") continue;
      lines = lines.concat(pathPolylineSegments(child));
      lineWidth = styleNumberValue(child.style && child.style.lineWidth, lineWidth);
      stroke = styleColorValue(child.style && child.style.stroke) || stroke;
      strokeOpacity = styleNumberValue(child.style && child.style.strokeOpacity, strokeOpacity);
    }
    hostLog("debug", "[pattern.lines] n=" + lines.length + " " + JSON.stringify(lines.slice(0, 3)));
    return {
      __patternCanvas: true,
      pattern_key: String(el.entity || el.id || "pattern"),
      width: styleNumberValue(style.width, 0),
      height: styleNumberValue(style.height, 0),
      fill,
      lines,
      line_width: lineWidth,
      stroke,
      stroke_opacity: strokeOpacity,
    };
  } catch (error) {
    hostLog("warn", "[pattern.render-failed] " + error);
    return null;
  }
}

function styleNumberValue(value, fallback) {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  const n = Number(value);
  return Number.isFinite(n) && String(value || "").trim() !== "" ? n : fallback;
}

function styleColorValue(value) {
  if (Array.isArray(value)) return normalizeColor(value);
  if (typeof value === "string") return parseColorString(value);
  if (value && typeof value.value === "string") return parseColorString(value.value);
  return null;
}

function pathPolylineSegments(el) {
  const d = (el.style && el.style.d) || "";
  if (typeof d !== "string") return [];
  // Minimal SVG path parser: M/L/H/V/Z polylines (the g-API pattern shapes).
  const tokens = d.match(/[MLHVZmlhvz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let current = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === undefined) break;
    const upper = command.toUpperCase();
    const relative = command !== upper;
    if (upper === "Z") {
      current = null;
      continue;
    }
    let more = true;
    while (more) {
      let x;
      let y;
      if (upper === "H") {
        x = num();
        y = current ? current[1] : 0;
      } else if (upper === "V") {
        x = current ? current[0] : 0;
        y = num();
      } else {
        x = num();
        y = num();
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        more = false;
        i -= 1;
        break;
      }
      const ax = relative && current ? current[0] + x : x;
      const ay = relative && current ? current[1] + y : y;
      if (upper === "M") {
        current = [ax, ay];
        // subsequent coordinate pairs continue as implicit lineto
      } else if (current) {
        out.push([current[0], current[1], ax, ay]);
        current = [ax, ay];
      } else {
        current = [ax, ay];
      }
      // implicit repeats only for M->L chains handled by loop; stop for M/L pairs
      more = false;
    }
  }
  return out;
}


function makeNoopObject(type, extra = {}) {
  const target = defineFake(
    {
      delete() {
        record(`${type}.delete`, arguments);
      },
      isDeleted() {
        record(`${type}.isDeleted`, arguments);
        return false;
      },
      ...extra,
    },
    type,
  );

  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "then") return undefined;
      if (prop in obj) return obj[prop];
      if (typeof prop === "symbol") return obj[prop];
      return function () {
        record(`${type}.${String(prop)}`, arguments);
        return undefined;
      };
    },
  });
}

class FakePath {
  constructor() {
    defineFake(this, "Path");
    this.ops = [];
    record("new Path", []);
  }

  _push(name, values) {
    this.ops.push([name, ...values]);
    record(`Path.${name}`, values);
    return this;
  }

  moveTo(x, y) {
    return this._push("moveTo", [x, y]);
  }

  lineTo(x, y) {
    return this._push("lineTo", [x, y]);
  }

  quadTo(x1, y1, x2, y2) {
    return this._push("quadTo", [x1, y1, x2, y2]);
  }

  cubicTo(x1, y1, x2, y2, x3, y3) {
    return this._push("cubicTo", [x1, y1, x2, y2, x3, y3]);
  }

  arcToRotated(rx, ry, angle, smallArc, sweep, x, y) {
    return this._push("arcToRotated", [rx, ry, angle, smallArc, sweep, x, y]);
  }

  addPoly(points, close) {
    return this._push("addPoly", [points, close]);
  }

  addRRect(rrect) {
    return this._push("addRRect", [rrect]);
  }

  transform(matrix) {
    record("Path.transform", [matrix]);
    if (shouldSkipDuplicatePathTranslate(this.ops, matrix)) return this;
    this.ops.push(["transform", matrix]);
    return this;
  }

  copy() {
    record("Path.copy", []);
    const next = new FakePath();
    next.ops = this.ops.slice();
    return next;
  }

  close() {
    return this._push("close", []);
  }

  delete() {
    record("Path.delete", []);
  }
}

class FakePaint {
  constructor() {
    defineFake(this, "Paint");
    this.state = {};
    record("new Paint", []);
  }

  _set(name, value) {
    this.state[name] = value;
    record(`Paint.${name}`, [value]);
    return this;
  }

  setAntiAlias(value) {
    return this._set("antiAlias", value);
  }

  setStyle(value) {
    return this._set("style", value);
  }

  setColor(value) {
    return this._set("color", normalizeColor(value));
  }

  setColorComponents(r, g, b, a) {
    return this._set("color", normalizeColor([r, g, b, a]));
  }

  setAlphaf(value) {
    return this._set("alpha", value);
  }

  setShader(value) {
    return this._set("shader", value);
  }

  setStrokeWidth(value) {
    return this._set("strokeWidth", value);
  }

  setStrokeCap(value) {
    return this._set("strokeCap", value);
  }

  setStrokeJoin(value) {
    return this._set("strokeJoin", value);
  }

  setStrokeMiter(value) {
    return this._set("strokeMiter", value);
  }

  setPathEffect(value) {
    return this._set("pathEffect", value);
  }

  setMaskFilter(value) {
    return this._set("maskFilter", value);
  }

  copy() {
    record("Paint.copy", []);
    const next = new FakePaint();
    next.state = { ...this.state };
    return next;
  }

  delete() {
    record("Paint.delete", []);
  }
}

class FakeFont {
  constructor(typeface, size) {
    defineFake(this, "Font");
    this.typeface = typeface;
    this.size = size;
    record("new Font", [typeface, size]);
  }

  delete() {
    record("Font.delete", []);
  }
}

class FakeParagraphStyle {
  constructor(style) {
    defineFake(this, "ParagraphStyle");
    this.style = style;
    record("new ParagraphStyle", [style]);
  }
}

class FakeParagraph {
  constructor(text, paragraphStyle, textStyle, sourceLayout) {
    defineFake(this, "Paragraph");
    this.text = text || "";
    this.width = 0;
    this.paragraphStyle = paragraphStyle || {};
    this.textStyle = textStyle || {};
    this.sourceLayout = sourceLayout || {};
    this.metrics = measureParagraph(this.text, this.textStyle, this.paragraphStyle, 0);
    record("new Paragraph", [text, paragraphStyle, textStyle, sourceLayout]);
  }

  layout(width) {
    this.width = Number(width) || 0;
    this.metrics = measureParagraph(
      this.text,
      this.textStyle,
      this.paragraphStyle,
      this.width,
    );
    record("Paragraph.layout", [width]);
  }

  getHeight() {
    record("Paragraph.getHeight", []);
    return finiteNumber(this.metrics?.height, finiteNumber(this.textStyle?.fontSize, 12));
  }

  getMaxWidth() {
    record("Paragraph.getMaxWidth", []);
    return finiteNumber(
      this.metrics?.maxWidth,
      this.width || Math.max(1, this.text.length * 8),
    );
  }

  delete() {
    record("Paragraph.delete", []);
  }
}

class FakeParagraphBuilder {
  constructor(style, fontMgr) {
    defineFake(this, "ParagraphBuilder");
    this.style = style;
    this.fontMgr = fontMgr;
    this.parts = [];
    this.paragraphStyle = { ...(style?.style || {}) };
    this.styleStack = [{ ...(style?.style?.textStyle || {}) }];
    this.sourceLayout = { ...(globalThis.__fakeCanvasKitTextLayoutContext || {}) };
    record("new ParagraphBuilder", [style, fontMgr]);
  }

  addText(text) {
    this.parts.push(String(text));
    record("ParagraphBuilder.addText", [text]);
    return this;
  }

  pushStyle(style) {
    const currentStyle = this.styleStack[this.styleStack.length - 1] || {};
    this.styleStack.push({
      ...currentStyle,
      ...(style || {}),
    });
    record("ParagraphBuilder.pushStyle", [style]);
    return this;
  }

  pop() {
    record("ParagraphBuilder.pop", []);
    if (this.styleStack.length > 1) {
      this.styleStack.pop();
    }
    return this;
  }

  build() {
    record("ParagraphBuilder.build", []);
    const currentStyle = this.styleStack[this.styleStack.length - 1] || {};
    return new FakeParagraph(
      this.parts.join(""),
      this.paragraphStyle,
      currentStyle,
      this.sourceLayout,
    );
  }

  delete() {
    record("ParagraphBuilder.delete", []);
  }
}

function createFakeCanvas() {
  const target = defineFake(
    {
      save() {
        record("Canvas.save", arguments);
        recordCommand("save");
      },
      restore() {
        record("Canvas.restore", arguments);
        recordCommand("restore");
      },
      translate(x, y) {
        record("Canvas.translate", [x, y]);
        recordCommand("translate", { x: finiteNumber(x), y: finiteNumber(y) });
      },
      skew(x, y) {
        record("Canvas.skew", [x, y]);
        recordCommand("skew", { x: finiteNumber(x), y: finiteNumber(y) });
      },
      rotate(deg, x, y) {
        record("Canvas.rotate", [deg, x, y]);
        recordCommand("rotate", {
          degrees: finiteNumber(deg),
          cx: finiteNumber(x, 0),
          cy: finiteNumber(y, 0),
        });
      },
      scale(x, y) {
        record("Canvas.scale", [x, y]);
        recordCommand("scale", { x: finiteNumber(x, 1), y: finiteNumber(y, 1) });
      },
      concat(matrix) {
        record("Canvas.concat", [matrix]);
        recordCommand("concat", {
          matrix: Array.isArray(matrix) ? matrix.map((value) => finiteNumber(value, 0)) : [],
        });
      },
      clear(color) {
        record("Canvas.clear", [color]);
        recordCommand("clear", { color: normalizeColor(color) });
      },
      clipPath(path, clipOp, antialias) {
        record("Canvas.clipPath", [path, clipOp, antialias]);
        recordCommand("clipPath", {
          path: snapshotPath(path),
          clipOp: clipOp || "intersect",
          antialias: !!antialias,
        });
      },
      drawRect(rect, paint) {
        record("Canvas.drawRect", [rect, paint]);
        recordCommand("drawRect", {
          rect: Array.isArray(rect) ? rect.map((value) => finiteNumber(value, 0)) : [],
          paint: snapshotPaint(paint),
        });
      },
      drawRRect(rrect, paint) {
        record("Canvas.drawRRect", [rrect, paint]);
        recordCommand("drawRRect", {
          rrect: Array.isArray(rrect) ? rrect.map((value) => finiteNumber(value, 0)) : [],
          paint: snapshotPaint(paint),
        });
      },
      drawPath(path, paint) {
        record("Canvas.drawPath", [path, paint]);
        recordCommand("drawPath", {
          path: snapshotPath(path),
          paint: snapshotPaint(paint),
        });
      },
      drawLine(x1, y1, x2, y2, paint) {
        record("Canvas.drawLine", [x1, y1, x2, y2, paint]);
        recordCommand("drawLine", {
          x1: finiteNumber(x1),
          y1: finiteNumber(y1),
          x2: finiteNumber(x2),
          y2: finiteNumber(y2),
          paint: snapshotPaint(paint),
        });
      },
      drawCircle(cx, cy, r, paint) {
        record("Canvas.drawCircle", [cx, cy, r, paint]);
        recordCommand("drawCircle", {
          cx: finiteNumber(cx),
          cy: finiteNumber(cy),
          r: finiteNumber(r),
          paint: snapshotPaint(paint),
        });
      },
      drawOval(rect, paint) {
        record("Canvas.drawOval", [rect, paint]);
        recordCommand("drawOval", {
          rect: Array.isArray(rect) ? rect.map((value) => finiteNumber(value, 0)) : [],
          paint: snapshotPaint(paint),
        });
      },
      drawImageRectOptions(image, srcRect, dstRect, filter, mipmap, paint) {
        record("Canvas.drawImageRectOptions", [image, srcRect, dstRect, filter, mipmap, paint]);
        const state = (image && image.state) || {};
        recordCommand("drawImageRectOptions", {
          image: state.encoded
            ? { encoded: state.encoded }
            : state.rgba && state.width && state.height
              ? { rgba: state.rgba, width: state.width, height: state.height }
              : null,
          srcRect: Array.isArray(srcRect) ? srcRect.map((value) => finiteNumber(value, 0)) : [],
          dstRect: Array.isArray(dstRect) ? dstRect.map((value) => finiteNumber(value, 0)) : [],
          paint: snapshotPaint(paint),
        });
      },
      drawParagraph(paragraph, x, y) {
        record("Canvas.drawParagraph", [paragraph, x, y]);
        recordCommand("drawParagraph", snapshotParagraph(paragraph, x, y));
      },
      drawTextBlob(blob, x, y, paint) {
        record("Canvas.drawTextBlob", [blob, x, y, paint]);
        recordCommand("drawTextBlob", {
          textBlob: serializeArg(blob),
          x: finiteNumber(x),
          y: finiteNumber(y),
          paint: snapshotPaint(paint),
        });
      },
      getTotalMatrix() {
        record("Canvas.getTotalMatrix", []);
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      },
    },
    "Canvas",
  );

  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "then") return undefined;
      if (prop in obj) return obj[prop];
      if (typeof prop === "symbol") return obj[prop];
      return function () {
        record(`Canvas.${String(prop)}`, arguments);
        return undefined;
      };
    },
  });
}

function createFakeSurface(htmlCanvas) {
  const layer = {
    index: layers.length,
    x: 0,
    y: 0,
    width: finiteNumber(htmlCanvas && htmlCanvas.__cssWidth) || 0,
    height: finiteNumber(htmlCanvas && htmlCanvas.__cssHeight) || 0,
    canvas: htmlCanvas || null,
    commands: [],
  };
  layers.push(layer);
  const canvas = createFakeCanvas();
  // Route every canvas op to this layer; frames of different surfaces interleave
  // in creation order, so binding at call time keeps each frame in its layer.
  const boundCanvas = new Proxy(canvas, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === "function") {
        return function (...args) {
          activeLayer = layer;
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
  let frameCount = 0;
  return defineFake(
    {
      getCanvas() {
        record("Surface.getCanvas", arguments);
        return boundCanvas;
      },
      makeImageFromTextureSource(source) {
        record("Surface.makeImageFromTextureSource", [source]);
        if (source && source.__base64) {
          return makeTextureImage({
            encoded: source.__base64,
            width: source.naturalWidth,
            height: source.naturalHeight,
          });
        }
        if (source && source.__patternCanvas && typeof globalThis.__rust_rasterize_pattern === "function") {
          const w = Math.max(1, Math.round(styleNumberValue(source.width, 1)));
          const h = Math.max(1, Math.round(styleNumberValue(source.height, 1)));
          const rgba = globalThis.__rust_rasterize_pattern(
            JSON.stringify({
              width: w,
              height: h,
              fill: source.fill,
              lines: source.lines,
              line_width: source.line_width,
              stroke: source.stroke,
              stroke_opacity: source.stroke_opacity,
            }),
          );
          if (rgba) return makeTextureImage({ rgba, width: w, height: h });
        }
        if (source && source._pixels && source._width && typeof globalThis.__rust_encode_png === "function") {
          return makeTextureImage({
            rgba: base64Encode(source.ensurePixels()),
            width: source._width,
            height: source._height,
          });
        }
        return makeNoopObject("Image");
      },
      MakeImageFromTextureSource(source) {
        return surface.makeImageFromTextureSource(source);
      },
      makeImageSnapshot() {
        record("Surface.makeImageSnapshot", arguments);
        return makeNoopObject("ImageSnapshot", {
          encodeToBytes() {
            record("ImageSnapshot.encodeToBytes", arguments);
            return new Uint8Array();
          },
        });
      },
      requestAnimationFrame(callback) {
        record("Surface.requestAnimationFrame", arguments);
        if (frameCount >= 1) {
          record("Surface.requestAnimationFrame.skipped", [frameCount]);
          return frameCount;
        }
        frameCount += 1;
        if (typeof callback === "function") callback(canvas);
        return frameCount;
      },
      flush() {
        record("Surface.flush", arguments);
        activeLayer = layer;
        recordCommand("flush");
      },
      deleteLater() {
        record("Surface.deleteLater", arguments);
      },
      delete() {
        record("Surface.delete", arguments);
      },
      isDeleted() {
        record("Surface.isDeleted", arguments);
        return false;
      },
      htmlCanvas,
    },
    "Surface",
  );
}

function createFakeCanvasKit() {
  const CanvasKit = {
    Paint: FakePaint,
    Path: FakePath,
    Font: FakeFont,
    ParagraphStyle: FakeParagraphStyle,
    ParagraphBuilder: {
      Make(style, fontMgr) {
        record("ParagraphBuilder.Make", [style, fontMgr]);
        return new FakeParagraphBuilder(style, fontMgr);
      },
    },
    TextBlob: {
      MakeOnPath(text, path, font) {
        record("TextBlob.MakeOnPath", [text, path, font]);
        return makeNoopObject("TextBlob");
      },
    },
    TypefaceFontProvider: {
      Make() {
        record("TypefaceFontProvider.Make", arguments);
        return makeNoopObject("TypefaceFontProvider", {
          registerFont(data, name) {
            record("TypefaceFontProvider.registerFont", [data, name]);
          },
        });
      },
    },
    Typeface: {
      MakeFreeTypeFaceFromData(data) {
        record("Typeface.MakeFreeTypeFaceFromData", [data]);
        return makeNoopObject("Typeface");
      },
    },
    FontMgr: {
      FromData() {
        record("FontMgr.FromData", arguments);
        return makeNoopObject("FontMgr");
      },
    },
    PathEffect: {
      MakeDash(intervals, phase) {
        record("PathEffect.MakeDash", [intervals, phase]);
        return defineFake(
          {
            state: {
              kind: "dash",
              intervals: Array.isArray(intervals) ? intervals.slice() : [],
              phase,
            },
            delete() {
              record("PathEffect.delete", arguments);
            },
            isDeleted() {
              record("PathEffect.isDeleted", arguments);
              return false;
            },
          },
          "PathEffect",
        );
      },
    },
    MaskFilter: {
      MakeBlur(style, sigma, respectCTM) {
        record("MaskFilter.MakeBlur", [style, sigma, respectCTM]);
        return makeNoopObject("MaskFilter", { state: { kind: "blur", sigma: finiteNumber(sigma) } });
      },
    },
    Shader: {
      MakeImageFromEncoded(data) {
        record("CanvasKit.MakeImageFromEncoded", [data]);
        return makeNoopObject("Image", {
          state: { encoded: toBase64(new Uint8Array(data || [])) },
        });
      },
      MakeImage(info, pixels) {
        record("CanvasKit.MakeImage", [info, pixels]);
        return makeNoopObject("Image", {
          state: {
            rgba: toBase64(new Uint8Array(pixels || [])),
            width: finiteNumber(info && info.width),
            height: finiteNumber(info && info.height),
          },
        });
      },
      MakeImageFromCanvasImageSource(source) {
        record("CanvasKit.MakeImageFromCanvasImageSource", [source]);
        return makeNoopObject("Image");
      },
      MakeLinearGradient(start, end, colors, pos, tileMode) {
        record("Shader.MakeLinearGradient", [start, end, colors, pos, tileMode]);
        return makeNoopObject("Shader", {
          state: {
            kind: "linear",
            start: [finiteNumber(start && start[0]), finiteNumber(start && start[1])],
            end: [finiteNumber(end && end[0]), finiteNumber(end && end[1])],
            colors: flattenColorArray(colors),
            positions: Array.from(pos || []).map((v) => finiteNumber(v)),
          },
        });
      },
      MakeRadialGradient(center, radius, colors, pos, tileMode) {
        record("Shader.MakeRadialGradient", [center, radius, colors, pos, tileMode]);
        return makeNoopObject("Shader", {
          state: {
            kind: "radial",
            center: [finiteNumber(center && center[0]), finiteNumber(center && center[1])],
            radius: finiteNumber(radius),
            colors: flattenColorArray(colors),
            positions: Array.from(pos || []).map((v) => finiteNumber(v)),
          },
        });
      },
      MakeBlend(mode, a, b) {
        record("Shader.MakeBlend", [mode, a, b]);
        return makeNoopObject("Shader", { state: { kind: "blend" } });
      },
    },
    Color4f(r, g, b, a = 1) {
      record("Color4f", [r, g, b, a]);
      return normalizeColor([r, g, b, a]) || [0, 0, 0, 1];
    },
    parseColorString(value) {
      record("parseColorString", [value]);
      return parseColorString(value) || [0, 0, 0, 1];
    },
    XYWHRect(x, y, width, height) {
      record("XYWHRect", [x, y, width, height]);
      return [x, y, x + width, y + height];
    },
    LTRBRect(left, top, right, bottom) {
      record("LTRBRect", [left, top, right, bottom]);
      return [left, top, right, bottom];
    },
    RRectXY(rect, rx, ry) {
      record("RRectXY", [rect, rx, ry]);
      return { rect, rx, ry };
    },
    MakeWebGLCanvasSurface(canvas) {
      record("MakeWebGLCanvasSurface", [canvas]);
      return createFakeSurface(canvas);
    },
    MakeManagedAnimation(json, assets) {
      record("MakeManagedAnimation", [json, assets]);
      return makeNoopObject("ManagedAnimation", {
        getSize() {
          record("ManagedAnimation.getSize", arguments);
          return [0, 0];
        },
        render() {
          record("ManagedAnimation.render", arguments);
        },
      });
    },
    MakeParticles(json, assets) {
      record("MakeParticles", [json, assets]);
      return makeNoopObject("Particles");
    },
    PaintStyle: {
      Fill: "fill",
      Stroke: "stroke",
    },
    StrokeCap: {
      Butt: "butt",
      Round: "round",
      Square: "square",
    },
    StrokeJoin: {
      Miter: "miter",
      Round: "round",
      Bevel: "bevel",
    },
    TextAlign: {
      Left: "left",
      Center: "center",
      Right: "right",
      End: "end",
      Start: "start",
    },
    TextBaseline: {
      Alphabetic: "alphabetic",
      Ideographic: "ideographic",
    },
    TextDirection: {
      LTR: "ltr",
      RTL: "rtl",
    },
    DecorationStyle: {
      Solid: "solid",
      Double: "double",
      Dotted: "dotted",
      Dashed: "dashed",
      Wavy: "wavy",
    },
    NoDecoration: 0,
    UnderlineDecoration: 1,
    OverlineDecoration: 2,
    LineThroughDecoration: 3,
    TileMode: {
      Clamp: "clamp",
      Mirror: "mirror",
      Repeat: "repeat",
      Decal: "decal",
    },
    ClipOp: {
      Intersect: "intersect",
    },
    FilterMode: {
      Linear: "linear",
    },
    MipmapMode: {
      None: "none",
    },
    BlendMode: {
      SrcOver: "src-over",
    },
    BlurStyle: {
      Normal: "normal",
    },
    ImageFormat: {
      PNG: "png",
      JPEG: "jpeg",
      WEBP: "webp",
    },
  };

  return new Proxy(CanvasKit, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (prop in target) return target[prop];
      if (typeof prop === "symbol") return target[prop];
      return function () {
        record(`CanvasKit.${String(prop)}`, arguments);
        return makeNoopObject(`CanvasKit.${String(prop)}`);
      };
    },
  });
}

export function createFakeCanvasKitInit() {
  return function fakeCanvasKitInit(options = {}) {
    trace.length = 0;
    nextId = 1;
    // Each init owns one layer; commands accumulate per layer across inits.
    activeLayer = null;
    globalThis.__fakeCanvasKitCurrentObject = null;
    globalThis.__fakeCanvasKitCurrentPaints = null;
    globalThis.__fakeCanvasKitTextLayoutContext = null;
    record("CanvasKitInit", [options]);
    const kit = createFakeCanvasKit();
    globalThis.__fakeCanvasKit = kit;
    globalThis.__getFakeCanvasKitTrace = function () {
      return trace.slice();
    };
    globalThis.__getFakeCanvasKitLayers = function () {
      return layers.map((layer) => ({
        index: layer.index,
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        // live element reference for layout computation; stripped at collect time
        canvas: layer.canvas,
        commands: layer.commands.slice(),
      }));
    };
    globalThis.__getFakeCanvasKitCommands = function () {
      const all = [];
      for (const layer of layers) all.push(...layer.commands);
      return all;
    };
    return Promise.resolve(kit);
  };
}
