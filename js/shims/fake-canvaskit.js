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
const commands = [];
let nextId = 1;
const MAX_TRACE = 2000;
const MAX_COMMANDS = 10000;
const MAX_HOST_LOG = 200;
let hostLogCount = 0;

function record(name, args) {
  const entry = {
    index: trace.length,
    name,
    args: Array.from(args || []).map((value) => serializeArg(value)),
  };
  if (trace.length < MAX_TRACE) trace.push(entry);
  if (hostLogCount < MAX_HOST_LOG) {
    hostLogCount += 1;
    hostLog("debug", `[fake-canvaskit] ${name}`, entry.args);
  }
  return entry;
}

function recordCommand(kind, payload = {}) {
  const entry = {
    index: commands.length,
    kind,
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
    hasShader: state.shader !== undefined,
    hasPathEffect: state.pathEffect !== undefined,
    hasMaskFilter: state.maskFilter !== undefined,
    pathEffect: snapshotPathEffect(state.pathEffect),
  };
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
  return Array.isArray(path.ops)
    ? path.ops.map((op) => op.map((value, index) => (index === 0 ? value : finiteNumber(value))))
    : [];
}

function snapshotParagraph(paragraph, x, y) {
  if (!paragraph || typeof paragraph !== "object") return null;
  const style = paragraph.style || {};
  return {
    text: String(paragraph.text || ""),
    width: finiteNumber(paragraph.width, 0),
    x: finiteNumber(x, 0),
    y: finiteNumber(y, 0),
    fontSize: finiteNumber(style.fontSize, 12),
    color: normalizeColor(style.color),
    textAlign: style.textAlign || "left",
    fontFamilies: Array.isArray(style.fontFamilies) ? style.fontFamilies.map(String) : [],
  };
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
    return this._push("transform", [matrix]);
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
  constructor(text, style) {
    defineFake(this, "Paragraph");
    this.text = text || "";
    this.width = 0;
    this.style = style || {};
    record("new Paragraph", [text, style]);
  }

  layout(width) {
    this.width = Number(width) || 0;
    record("Paragraph.layout", [width]);
  }

  getHeight() {
    record("Paragraph.getHeight", []);
    return 14;
  }

  getMaxWidth() {
    record("Paragraph.getMaxWidth", []);
    return this.width || Math.max(1, this.text.length * 8);
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
    this.currentStyle = { ...(style?.style?.textStyle || {}) };
    record("new ParagraphBuilder", [style, fontMgr]);
  }

  addText(text) {
    this.parts.push(String(text));
    record("ParagraphBuilder.addText", [text]);
    return this;
  }

  pushStyle(style) {
    this.currentStyle = {
      ...this.currentStyle,
      ...(style || {}),
    };
    record("ParagraphBuilder.pushStyle", [style]);
    return this;
  }

  pop() {
    record("ParagraphBuilder.pop", []);
    return this;
  }

  build() {
    record("ParagraphBuilder.build", []);
    return new FakeParagraph(this.parts.join(""), this.currentStyle);
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
        recordCommand("drawImageRectOptions", {
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
  const canvas = createFakeCanvas();
  let frameCount = 0;
  return defineFake(
    {
      getCanvas() {
        record("Surface.getCanvas", arguments);
        return canvas;
      },
      makeImageFromTextureSource(source) {
        record("Surface.makeImageFromTextureSource", [source]);
        return makeNoopObject("Image");
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
        if (frameCount >= 4) {
          record("Surface.requestAnimationFrame.skipped", [frameCount]);
          return frameCount;
        }
        frameCount += 1;
        Promise.resolve().then(() => {
          if (typeof callback === "function") callback(canvas);
        });
        return frameCount;
      },
      flush() {
        record("Surface.flush", arguments);
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
        return makeNoopObject("MaskFilter");
      },
    },
    Shader: {
      MakeLinearGradient(start, end, colors, pos, tileMode) {
        record("Shader.MakeLinearGradient", [start, end, colors, pos, tileMode]);
        return makeNoopObject("Shader");
      },
      MakeRadialGradient(center, radius, colors, pos, tileMode) {
        record("Shader.MakeRadialGradient", [center, radius, colors, pos, tileMode]);
        return makeNoopObject("Shader");
      },
      MakeBlend(mode, a, b) {
        record("Shader.MakeBlend", [mode, a, b]);
        return makeNoopObject("Shader");
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
    commands.length = 0;
    hostLogCount = 0;
    record("CanvasKitInit", [options]);
    const kit = createFakeCanvasKit();
    globalThis.__fakeCanvasKit = kit;
    globalThis.__getFakeCanvasKitTrace = function () {
      return trace.slice();
    };
    globalThis.__getFakeCanvasKitCommands = function () {
      return commands.slice();
    };
    return Promise.resolve(kit);
  };
}
