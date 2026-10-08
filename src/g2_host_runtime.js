(function () {
  function hostLog(level, message) {
    if (typeof globalThis.__rust_log === "function") {
      globalThis.__rust_log(String(level), String(message));
    }
  }

  function formatArgs(args) {
    return Array.prototype.map
      .call(args, function (value) {
        if (value instanceof Error) {
          return value.stack || value.message || String(value);
        }
        if (value && typeof value === "object") {
          if (typeof value.stack === "string") return value.stack;
          if (typeof value.message === "string") return value.message;
        }
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch (error) {
          return String(value);
        }
      })
      .join(" ");
  }

  function makeClassList(element) {
    return {
      add: function () {
        hostLog("debug", "[classList.add] " + element.tagName);
      },
      remove: function () {
        hostLog("debug", "[classList.remove] " + element.tagName);
      },
    };
  }

  function Element(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument || null;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.parentElement = null;
    this.parentNode = null;
    this.classList = makeClassList(this);
  }

  function parseCssPixels(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value !== "string") return 0;
    var match = /(-?\d+(?:\.\d+)?)/.exec(value);
    return match ? Number(match[1]) : 0;
  }

  Element.prototype.appendChild = function (child) {
    if (!child) return child;
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    hostLog("debug", "[appendChild] " + this.tagName + " <= " + child.tagName);
    return child;
  };

  Element.prototype.removeChild = function (child) {
    var index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child) {
      child.parentElement = null;
      child.parentNode = null;
    }
    hostLog("debug", "[removeChild] " + this.tagName + " -/-> " + (child && child.tagName));
    return child;
  };

  Element.prototype.cloneNode = function () {
    return this.ownerDocument.createElement(this.tagName.toLowerCase());
  };

  Element.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
  };

  Element.prototype.getAttribute = function (name) {
    return this.attributes[name];
  };

  Element.prototype.addEventListener = function (type) {
    hostLog("debug", "[addEventListener] " + this.tagName + " " + type);
  };

  Element.prototype.removeEventListener = function (type) {
    hostLog("debug", "[removeEventListener] " + this.tagName + " " + type);
  };

  Element.prototype.dispatchEvent = function (event) {
    hostLog("debug", "[dispatchEvent] " + this.tagName + " " + (event && event.type));
    return true;
  };

  // Minimal innerHTML: block children inherit the parent's content width the way
  // browser block layout would, so autoFit charts inside nested divs get sized.
  var VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };
  var TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)>/g;

  function parseStyleAttribute(text) {
    var style = {};
    var parts = String(text || "").split(";");
    for (var i = 0; i < parts.length; i++) {
      var idx = parts[i].indexOf(":");
      if (idx <= 0) continue;
      style[parts[i].slice(0, idx).trim().toLowerCase()] = parts[i].slice(idx + 1).trim();
    }
    return style;
  }

  Element.prototype.setInnerHTML = function (html) {
    this.children.length = 0;
    var stack = [this];
    var parentWidth = this.getBoundingClientRect().width;
    var match;
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(String(html || ""))) !== null) {
      var closing = match[1] === "/";
      var tag = match[2].toLowerCase();
      if (closing) {
        for (var s = stack.length - 1; s > 0; s--) {
          if (stack[s].tagName.toLowerCase() === tag) {
            stack.length = s;
            break;
          }
        }
        continue;
      }
      var attrs = match[3] || "";
      var idMatch = /(?:^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/i.exec(attrs);
      var styleMatch = /(?:^|\s)style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      var child = tag === "canvas" && this.ownerDocument
        ? this.ownerDocument.createElement("canvas")
        : this.ownerDocument
          ? this.ownerDocument.createElement(tag)
          : new Element(tag, null);
      if (idMatch) {
        var id = idMatch[2] || idMatch[3] || idMatch[4] || "";
        if (id) {
          child.id = id;
          if (this.ownerDocument && this.ownerDocument.registerElement) {
            this.ownerDocument.registerElement(id, child);
          }
        }
      }
      if (styleMatch) {
        var styles = parseStyleAttribute(styleMatch[2] || styleMatch[1]);
        for (var key in styles) child.style[key] = styles[key];
      }
      if (!child.style.width && parentWidth > 0 && tag !== "canvas") {
        child.style.width = parentWidth + "px";
      }
      stack[stack.length - 1].appendChild(child);
      if (!VOID_TAGS[tag] && !/\/\s*$/.test(attrs)) stack.push(child);
    }
    hostLog("debug", "[innerHTML] " + this.tagName + " children=" + this.children.length);
  };

  if (!Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")) {
    Object.defineProperty(Element.prototype, "innerHTML", {
      set: function (value) {
        this.setInnerHTML(value);
      },
      get: function () {
        return "";
      },
      configurable: true,
    });
  }

  Element.prototype.getBoundingClientRect = function () {
    var width = Number(this.width || 0) || parseCssPixels(this.style.width);
    var height = Number(this.height || 0) || parseCssPixels(this.style.height);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width: width,
      height: height,
    };
  };

  Object.defineProperties(Element.prototype, {
    clientWidth: {
      get: function () {
        return Number(this.width || 0) || parseCssPixels(this.style.width);
      },
    },
    clientHeight: {
      get: function () {
        return Number(this.height || 0) || parseCssPixels(this.style.height);
      },
    },
    offsetWidth: {
      get: function () {
        return this.clientWidth;
      },
    },
    offsetHeight: {
      get: function () {
        return this.clientHeight;
      },
    },
  });

  function CanvasElement(ownerDocument) {
    Element.call(this, "canvas", ownerDocument);
    this._contexts = {};
    this._pixels = null;
    var canvas = this;
    Object.defineProperty(canvas, "width", {
      get: function () {
        return canvas._width || 0;
      },
      set: function (value) {
        var w = Math.max(0, Number(value) || 0);
        canvas._width = w;
        canvas._pixels = null;
      },
    });
    Object.defineProperty(canvas, "height", {
      get: function () {
        return canvas._height || 0;
      },
      set: function (value) {
        var h = Math.max(0, Number(value) || 0);
        canvas._height = h;
        canvas._pixels = null;
      },
    });
  }

  var NAMED_COLORS = {
    black: [0, 0, 0, 1],
    white: [255, 255, 255, 1],
    red: [255, 0, 0, 1],
    green: [0, 128, 0, 1],
    blue: [0, 0, 255, 1],
    yellow: [255, 255, 0, 1],
    orange: [255, 165, 0, 1],
    purple: [128, 0, 128, 1],
    transparent: [0, 0, 0, 0],
  };

  function parseCssColor(value) {
    if (typeof value !== "string") return null;
    var spec = value.trim().toLowerCase();
    if (NAMED_COLORS[spec]) return NAMED_COLORS[spec].slice();
    if (spec.charCodeAt(0) === 35) {
      var hex = spec.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        hex = hex
          .split("")
          .map(function (ch) {
            return ch + ch;
          })
          .join("");
      }
      if (hex.length === 6 || hex.length === 8) {
        return [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
          hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        ];
      }
      return null;
    }
    var m = spec.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var parts = m[1].split(/[,\/\s]+/).filter(Boolean);
      if (parts.length >= 3) {
        var r = Number(parts[0]);
        var g = Number(parts[1]);
        var b = Number(parts[2]);
        var a = parts.length > 3 ? Number(parts[3]) : 1;
        return [r, g, b, Number.isFinite(a) ? a : 1];
      }
    }
    return null;
  }

  function makeGradient(kind, coords) {
    return {
      __gradient: true,
      kind: kind,
      coords: coords,
      stops: [],
      addColorStop: function (offset, color) {
        this.stops.push([Number(offset) || 0, parseCssColor(color) || [0, 0, 0, 1]]);
        this.stops.sort(function (a, b) {
          return a[0] - b[0];
        });
      },
    };
  }

  function gradientColorAt(gradient, t) {
    var stops = gradient.stops;
    if (!stops.length) return [0, 0, 0, 0];
    if (t <= stops[0][0]) return stops[0][1];
    for (var i = 1; i < stops.length; i += 1) {
      if (t <= stops[i][0]) {
        var a = stops[i - 1];
        var b = stops[i];
        var f = (t - a[0]) / (b[0] - a[0] || 1);
        var out = [0, 0, 0, 0];
        for (var k = 0; k < 4; k += 1) out[k] = a[1][k] + (b[1][k] - a[1][k]) * f;
        return out;
      }
    }
    return stops[stops.length - 1][1];
  }

  CanvasElement.prototype = Object.create(Element.prototype);
  CanvasElement.prototype.constructor = CanvasElement;
  CanvasElement.prototype.ensurePixels = function () {
    var w = this._width || 0;
    var h = this._height || 0;
    if (!this._pixels || this._pixels.length !== w * h * 4) {
      this._pixels = new Uint8ClampedArray(w * h * 4);
    }
    return this._pixels;
  };


  function Canvas2DContext(canvas) {
    this.canvas = canvas;
    this.font = "12px sans-serif";
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
    this.fillStyle = "#000";
    this.globalAlpha = 1;
    this._lastTextY = 0;
    this._lastFontSize = 12;
    this._stateStack = [];
  }

  function parseFontSpec(fontSpec) {
    var spec = String(fontSpec || "").trim();
    var match = spec.match(/(?:(italic|oblique)\s+)?(?:(\d{3}|bold|normal)\s+)?(\d+(?:\.\d+)?)px\s+(.+)/i);
    if (!match) {
      return {
        italic: false,
        weight: 400,
        size: 12,
        families: "sans-serif",
      };
    }

    var weight = 400;
    var rawWeight = String(match[2] || "").toLowerCase();
    if (rawWeight === "bold") weight = 700;
    else if (rawWeight && rawWeight !== "normal") weight = Number(rawWeight) || 400;

    return {
      italic: !!match[1],
      weight: weight,
      size: Number(match[3]) || 12,
      families: match[4] || "sans-serif",
    };
  }

  function measureTextWithRust(text, fontSpec) {
    if (typeof globalThis.__rust_measure_text !== "function") return null;
    try {
      var parsed = parseFontSpec(fontSpec);
      var payload = globalThis.__rust_measure_text(
        String(text || ""),
        parsed.size,
        parsed.families,
        parsed.weight,
        parsed.italic,
      );
      return payload ? JSON.parse(payload) : null;
    } catch (error) {
      hostLog("warn", "[2d.measureText:rustrt] " + String(error));
      return null;
    }
  }

  Canvas2DContext.prototype.measureText = function (text) {
    var value = String(text || "");
    var parsed = parseFontSpec(this.font);
    var fontSize = parsed.size;
    var metrics = measureTextWithRust(value, this.font);
    var width = metrics && Number.isFinite(Number(metrics.width))
      ? Number(metrics.width)
      : value.length * fontSize * 0.6;
    hostLog("debug", "[2d.measureText] " + value + " => " + width);
    return {
      width: width,
      actualBoundingBoxAscent:
        metrics && Number.isFinite(Number(metrics.actualBoundingBoxAscent))
          ? Number(metrics.actualBoundingBoxAscent)
          : fontSize * 0.8,
      actualBoundingBoxDescent:
        metrics && Number.isFinite(Number(metrics.actualBoundingBoxDescent))
          ? Number(metrics.actualBoundingBoxDescent)
          : fontSize * 0.2,
      fontBoundingBoxAscent:
        metrics && Number.isFinite(Number(metrics.fontBoundingBoxAscent))
          ? Number(metrics.fontBoundingBoxAscent)
          : fontSize * 0.8,
      fontBoundingBoxDescent:
        metrics && Number.isFinite(Number(metrics.fontBoundingBoxDescent))
          ? Number(metrics.fontBoundingBoxDescent)
          : fontSize * 0.2,
    };
  };

  Canvas2DContext.prototype.save = function () {
    hostLog("debug", "[2d.save]");
  };

  Canvas2DContext.prototype.restore = function () {
    hostLog("debug", "[2d.restore]");
  };

  Canvas2DContext.prototype.setTransform = function () {
    hostLog("debug", "[2d.setTransform]");
  };

  Canvas2DContext.prototype.resetTransform = function () {
    hostLog("debug", "[2d.resetTransform]");
  };

  Canvas2DContext.prototype.clearRect = function (x, y, w, h) {
    var canvas = this.canvas;
    var pw = canvas._width || 0;
    var ph = canvas._height || 0;
    var pixels = canvas.ensurePixels();
    var x0 = Math.max(0, Math.floor(Number(x) || 0));
    var y0 = Math.max(0, Math.floor(Number(y) || 0));
    var x1 = Math.min(pw, Math.ceil((Number(x) || 0) + (Number(w) || 0)));
    var y1 = Math.min(ph, Math.ceil((Number(y) || 0) + (Number(h) || 0)));
    for (var row = y0; row < y1; row += 1) {
      pixels.fill(0, (row * pw + x0) * 4, (row * pw + x1) * 4);
    }
  };

  Canvas2DContext.prototype.fillRect = function (x, y, w, h) {
    var canvas = this.canvas;
    var pw = canvas._width || 0;
    var ph = canvas._height || 0;
    if (!pw || !ph) return;
    var pixels = canvas.ensurePixels();
    var x0 = Math.max(0, Math.floor(Number(x) || 0));
    var y0 = Math.max(0, Math.floor(Number(y) || 0));
    var x1 = Math.min(pw, Math.ceil((Number(x) || 0) + (Number(w) || 0)));
    var y1 = Math.min(ph, Math.ceil((Number(y) || 0) + (Number(h) || 0)));
    var fill = this.fillStyle;
    var gradient = fill && fill.__gradient ? fill : null;
    var solid = gradient ? null : parseCssColor(fill);
    if (!gradient && !solid) return;
    var alpha = Math.max(0, Math.min(1, Number(this.globalAlpha) || 0));
    for (var row = y0; row < y1; row += 1) {
      for (var col = x0; col < x1; col += 1) {
        var color = solid;
        if (gradient) {
          var t = 0;
          if (gradient.kind === "radial") {
            var dx = col + 0.5 - gradient.coords[3];
            var dy = row + 0.5 - gradient.coords[4];
            var dist = Math.sqrt(dx * dx + dy * dy);
            var r0 = gradient.coords[2];
            var r1 = gradient.coords[5];
            t = r1 > r0 ? (dist - r0) / (r1 - r0) : dist > 0 ? 1 : 0;
          } else {
            var gx0 = gradient.coords[0];
            var gy0 = gradient.coords[1];
            var gx1 = gradient.coords[2];
            var gy1 = gradient.coords[3];
            var len = (gx1 - gx0) * (gx1 - gx0) + (gy1 - gy0) * (gy1 - gy0);
            t = len > 0 ? ((col + 0.5 - gx0) * (gx1 - gx0) + (row + 0.5 - gy0) * (gy1 - gy0)) / len : 0;
          }
          color = gradientColorAt(gradient, Math.max(0, Math.min(1, t)));
        }
        srcOver(pixels, (row * pw + col) * 4, color, alpha);
      }
    }
  };

  function srcOver(pixels, offset, color, extraAlpha) {
    var sa = Math.max(0, Math.min(1, color[3] * extraAlpha));
    if (sa <= 0) return;
    var da = pixels[offset + 3] / 255;
    var outA = sa + da * (1 - sa);
    if (outA <= 0) {
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
      pixels[offset + 3] = 0;
      return;
    }
    for (var k = 0; k < 3; k += 1) {
      var sc = color[k] * sa;
      var dc = pixels[offset + k] * da;
      pixels[offset + k] = Math.round((sc + dc * (1 - sa)) / outA);
    }
    pixels[offset + 3] = Math.round(outA * 255);
  }

  function sourcePixels(source) {
    if (source && source._pixels && source._width) {
      return { pixels: source._pixels, width: source._width, height: source._height };
    }
    if (source && source.__base64 && typeof globalThis.__rust_image_rgba === "function") {
      if (!source.__rgbaCache) {
        try {
          source.__rgbaCache = JSON.parse(globalThis.__rust_image_rgba(source.__base64));
        } catch (error) {
          source.__rgbaCache = null;
        }
      }
      var decoded = source.__rgbaCache;
      if (decoded && decoded.rgba) {
        return {
          pixels: base64Decode(decoded.rgba),
          width: decoded.width,
          height: decoded.height,
        };
      }
    }
    return null;
  }

  Canvas2DContext.prototype.drawImage = function (img) {
    var canvas = this.canvas;
    var pw = canvas._width || 0;
    var ph = canvas._height || 0;
    var pixels = canvas.ensurePixels();
    var src = sourcePixels(img);
    if (!src || !pw || !ph) return;
    var sw = src.width;
    var sh = src.height;
    var sx = 0;
    var sy = 0;
    var dx;
    var dy;
    var dw;
    var dh;
    if (arguments.length >= 9) {
      sx = Number(arguments[1]) || 0;
      sy = Number(arguments[2]) || 0;
      sw = Number(arguments[3]) || sw;
      sh = Number(arguments[4]) || sh;
      dx = Number(arguments[5]) || 0;
      dy = Number(arguments[6]) || 0;
      dw = Number(arguments[7]) || sw;
      dh = Number(arguments[8]) || sh;
    } else if (arguments.length >= 5) {
      dx = Number(arguments[1]) || 0;
      dy = Number(arguments[2]) || 0;
      dw = Number(arguments[3]) || sw;
      dh = Number(arguments[4]) || sh;
    } else {
      dx = Number(arguments[1]) || 0;
      dy = Number(arguments[2]) || 0;
      dw = sw;
      dh = sh;
    }
    var alpha = Math.max(0, Math.min(1, Number(this.globalAlpha) || 0));
    var dx0 = Math.max(0, Math.floor(dx));
    var dy0 = Math.max(0, Math.floor(dy));
    var dx1 = Math.min(pw, Math.ceil(dx + dw));
    var dy1 = Math.min(ph, Math.ceil(dy + dh));
    for (var row = dy0; row < dy1; row += 1) {
      for (var col = dx0; col < dx1; col += 1) {
        var u = sw > 0 ? Math.floor(((col - dx) / dw) * sw + sx) : 0;
        var v = sh > 0 ? Math.floor(((row - dy) / dh) * sh + sy) : 0;
        if (u < 0 || v < 0 || u >= src.width || v >= src.height) continue;
        var so = (v * src.width + u) * 4;
        var color = [
          src.pixels[so],
          src.pixels[so + 1],
          src.pixels[so + 2],
          src.pixels[so + 3] / 255,
        ];
        srcOver(pixels, (row * pw + col) * 4, color, alpha);
      }
    }
  }

  // Rasterize text with the same skia font pipeline the browser baseline uses.
  // g-lite derives font ascent/descent by scanning fillText output pixels, so a
  // stub here poisons ALL text layout.
  Canvas2DContext.prototype.fillText = function (text, x, y) {
    var canvas = this.canvas;
    var w = canvas._width || 0;
    var h = canvas._height || 0;
    if (!w || !h) {
      this._lastTextY = Number(y) || 0;
      return;
    }
    if (typeof globalThis.__rust_draw_text !== "function") return;
    var parsed = parseFontSpec(this.font);
    var color = parseCssColor(this.fillStyle) || [0, 0, 0, 1];
    var out = globalThis.__rust_draw_text(
      JSON.stringify({
        rgba: base64Encode(canvas.ensurePixels()),
        width: w,
        height: h,
        text: String(text || ""),
        x: Number(x) || 0,
        y: Number(y) || 0,
        font_size: parsed.size,
        font_families: parsed.families,
        font_weight: parsed.weight,
        italic: parsed.italic,
        r: color[0],
        g: color[1],
        b: color[2],
        a: color[3] * (Number(this.globalAlpha) || 0),
      }),
    );
    canvas._pixels = base64Decode(out);
  };

  Canvas2DContext.prototype.getImageData = function (x, y, width, height) {
    var canvas = this.canvas;
    var pw = canvas._width || 0;
    var ph = canvas._height || 0;
    var w = Math.max(1, Number(width) || pw || 1);
    var h = Math.max(1, Number(height) || ph || 1);
    var data = new Uint8ClampedArray(w * h * 4);
    var pixels = canvas.ensurePixels();
    var x0 = Math.floor(Number(x) || 0);
    var y0 = Math.floor(Number(y) || 0);
    for (var row = 0; row < h; row += 1) {
      var sy = y0 + row;
      if (sy < 0 || sy >= ph) continue;
      for (var col = 0; col < w; col += 1) {
        var sx = x0 + col;
        if (sx < 0 || sx >= pw) continue;
        var src = (sy * pw + sx) * 4;
        var dst = (row * w + col) * 4;
        data[dst] = pixels[src];
        data[dst + 1] = pixels[src + 1];
        data[dst + 2] = pixels[src + 2];
        data[dst + 3] = pixels[src + 3];
      }
    }
    hostLog("debug", "[2d.getImageData]");
    return { data: data, width: w, height: h };
  };

  Canvas2DContext.prototype.putImageData = function (imageData, dx, dy) {
    var canvas = this.canvas;
    var pw = canvas._width || 0;
    var ph = canvas._height || 0;
    var pixels = canvas.ensurePixels();
    var src = imageData && imageData.data;
    if (!src) return;
    var sw = Number(imageData.width) || Math.sqrt(src.length / 4) | 0;
    var x0 = Math.round(Number(dx) || 0);
    var y0 = Math.round(Number(dy) || 0);
    var sh = Math.floor(src.length / 4 / sw);
    for (var row = 0; row < sh; row += 1) {
      var ty = y0 + row;
      if (ty < 0 || ty >= ph) continue;
      for (var col = 0; col < sw; col += 1) {
        var tx = x0 + col;
        if (tx < 0 || tx >= pw) continue;
        var so = (row * sw + col) * 4;
        var dsto = (ty * pw + tx) * 4;
        pixels[dsto] = src[so];
        pixels[dsto + 1] = src[so + 1];
        pixels[dsto + 2] = src[so + 2];
        pixels[dsto + 3] = src[so + 3];
      }
    }
  };

  Canvas2DContext.prototype.createLinearGradient = function (x0, y0, x1, y1) {
    return makeGradient("linear", [Number(x0) || 0, Number(y0) || 0, Number(x1) || 0, Number(y1) || 0]);
  };

  Canvas2DContext.prototype.createRadialGradient = function (x0, y0, r0, x1, y1, r1) {
    return makeGradient("radial", [
      Number(x0) || 0,
      Number(y0) || 0,
      Number(r0) || 0,
      Number(x1) || 0,
      Number(y1) || 0,
      Number(r1) || 0,
    ]);
  };

  // BISECT: removed no-op path methods

  CanvasElement.prototype.toDataURL = function () {
    var w = this._width || 0;
    var h = this._height || 0;
    if (!w || !h || typeof globalThis.__rust_encode_png !== "function") {
      return "data:image/png;base64,";
    }
    var pixels = this.ensurePixels();
    var pngB64 = globalThis.__rust_encode_png(base64Encode(pixels), w, h);
    return "data:image/png;base64," + pngB64;
  };

  var B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64Encode(bytes) {
    // Chunked: naive `out +=` rope concat is O(n^2) in QuickJS and hangs on
    // multi-MB buffers (canvas.toDataURL of a full plot).
    var parts = [];
    var i = 0;
    var chunkOut = "";
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunkOut += B64_TABLE[(n >> 18) & 63] + B64_TABLE[(n >> 12) & 63] + B64_TABLE[(n >> 6) & 63] + B64_TABLE[n & 63];
      if (chunkOut.length >= 65536) {
        parts.push(chunkOut);
        chunkOut = "";
      }
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      var n1 = bytes[i] << 16;
      chunkOut += B64_TABLE[(n1 >> 18) & 63] + B64_TABLE[(n1 >> 12) & 63] + "==";
    } else if (rem === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      chunkOut += B64_TABLE[(n2 >> 18) & 63] + B64_TABLE[(n2 >> 12) & 63] + B64_TABLE[(n2 >> 6) & 63] + "=";
    }
    if (chunkOut) parts.push(chunkOut);
    return parts.join("");
  }

  function base64Decode(text) {
    var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
    var out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    var count = 0;
    for (var i = 0; i < clean.length; i += 4) {
      var c0 = B64_TABLE.indexOf(clean[i]);
      var c1 = B64_TABLE.indexOf(clean[i + 1]);
      var c2 = clean[i + 2] === "=" ? 0 : B64_TABLE.indexOf(clean[i + 2]);
      var c3 = clean[i + 3] === "=" ? 0 : B64_TABLE.indexOf(clean[i + 3]);
      var n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
      out[count++] = (n >> 16) & 0xff;
      if (clean[i + 2] !== "=") out[count++] = (n >> 8) & 0xff;
      if (clean[i + 3] !== "=") out[count++] = n & 0xff;
    }
    return out.subarray(0, count);
  }

  CanvasElement.prototype.getContext = function (kind) {
    if (kind === "2d") {
      if (!this._contexts[kind]) {
        this._contexts[kind] = new Canvas2DContext(this);
      }
      hostLog("debug", "[canvas.getContext] 2d");
      return this._contexts[kind];
    }
    hostLog("warn", "[canvas.getContext] " + kind + " not implemented");
    return { canvas: this };
  };

  function Document() {
    this._elements = {};
    this.body = new Element("body", this);
    this.documentElement = new Element("html", this);
    this.currentScript = null;
    this.defaultView = globalThis;
  }

  Document.prototype.createElement = function (tagName) {
    var tag = String(tagName || "div").toLowerCase();
    hostLog("debug", "[document.createElement] " + tag);
    return tag === "canvas" ? new CanvasElement(this) : new Element(tag, this);
  };

  Document.prototype.getElementById = function (id) {
    return this._elements[String(id)] || null;
  };

  Document.prototype.registerElement = function (id, element) {
    this._elements[String(id)] = element;
    return element;
  };

  Document.prototype.addEventListener = function (type) {
    hostLog("debug", "[document.addEventListener] " + type);
  };

  Document.prototype.removeEventListener = function (type) {
    hostLog("debug", "[document.removeEventListener] " + type);
  };

  var document = new Document();
  var rafId = 1;
  var rafCount = 0;
  var maxRafCallbacks = 512;
  // Virtual animation clock: rAF timestamps advance 100ms per frame so animation
  // timelines converge; when the script sets __g2FreezeMs the clock clamps there,
  // freezing every animation at exactly that frame (matches the browser harness).
  var virtualClock = 0;
  var hostConsoleEntries = [];

  function ensureContainer(id) {
    var existing = document.getElementById(id);
    if (existing) return existing;
    var element = document.createElement("div");
    element.id = id;
    document.registerElement(id, element);
    document.body.appendChild(element);
    hostLog("info", "[container.created] " + id);
    return element;
  }

  function resolveRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return String(input);
  }

  // Minimal Image backed by synchronous host fetch + header sniff. g-lite's
  // ImagePool assigns onload/onerror before setting src, so deferring the event
  // to a microtask is enough for listeners to be attached.
  function FakeImageElement() {
    var listeners = {};
    var img = {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      width: 0,
      height: 0,
      crossOrigin: null,
      onload: null,
      onerror: null,
      addEventListener: function (type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      removeEventListener: function (type, fn) {
        var list = listeners[type] || [];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      },
    };
    function fire(type, event) {
      (listeners[type] || []).slice().forEach(function (fn) {
        fn(event);
      });
      var handler = type === "load" ? img.onload : img.onerror;
      if (typeof handler === "function") handler(event);
    }
    Object.defineProperty(img, "src", {
      get: function () {
        return img.__src;
      },
      set: function (url) {
        img.__src = url;
        try {
          var encoded = String(url).indexOf("data:") === 0
            ? String(url).slice(String(url).indexOf(",") + 1)
            : globalThis.__rust_fetch_base64(url);
          if (typeof encoded !== "string") throw new Error("image fetch failed: " + url);
          img.__base64 = encoded;
          var dims = JSON.parse(globalThis.__rust_image_size(encoded));
          img.naturalWidth = img.width = dims.width;
          img.naturalHeight = img.height = dims.height;
          img.complete = true;
          queueMicrotask(function () {
            fire("load", { type: "load", target: img });
          });
        } catch (error) {
          hostLog("warn", "[image.load-failed] " + url + " " + error);
          img.complete = true;
          queueMicrotask(function () {
            fire("error", { type: "error", target: img });
          });
        }
      },
    });
    return img;
  }
  globalThis.Image = FakeImageElement;
  globalThis.HTMLImageElement = FakeImageElement;

  function createFetchResponse(url, bodyText) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      url: url,
      headers: {
        get: function (_name) {
          return null;
        },
      },
      text: function () {
        return Promise.resolve(bodyText);
      },
      json: function () {
        return Promise.resolve(JSON.parse(bodyText));
      },
      arrayBuffer: function () {
        var bytes = new TextEncoder().encode(bodyText);
        return Promise.resolve(bytes.buffer.slice(0));
      },
    };
  }

  function hostFetch(input) {
    var url = resolveRequestUrl(input);
    hostLog("info", "[fetch] " + url);
    try {
      if (typeof globalThis.__rust_fetch_text !== "function") {
        throw new Error("__rust_fetch_text is not installed");
      }
      var bodyText = globalThis.__rust_fetch_text(url);
      return Promise.resolve(createFetchResponse(url, bodyText));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = document;
  globalThis.navigator = { userAgent: "rquickjs" };
  globalThis.location = { href: "https://local.invalid/" };
  globalThis.devicePixelRatio = 1;
  globalThis.performance = {
    now: function () {
      return virtualClock;
    },
  };  globalThis.getComputedStyle = function (element) {
    var style = (element && element.style) || {};
    return {
      width: style.width || "0px",
      height: style.height || "0px",
      paddingLeft: style.paddingLeft || "0px",
      paddingRight: style.paddingRight || "0px",
      paddingTop: style.paddingTop || "0px",
      paddingBottom: style.paddingBottom || "0px",
    };
  };
  globalThis.fetch = hostFetch;
  globalThis.HTMLCanvasElement = CanvasElement;
  globalThis.OffscreenCanvas = CanvasElement;
  globalThis.addEventListener = function (type) {
    hostLog("debug", "[window.addEventListener] " + type);
  };
  globalThis.removeEventListener = function (type) {
    hostLog("debug", "[window.removeEventListener] " + type);
  };
  globalThis.requestAnimationFrame = function (callback) {
    hostLog("debug", "[requestAnimationFrame]");
    var id = rafId++;
    if (rafCount >= maxRafCallbacks) {
      hostLog("warn", "[requestAnimationFrame:dropped] " + id);
      return id;
    }
    rafCount += 1;
    Promise.resolve().then(function () {
      var freezeMs = globalThis.__g2FreezeMs;
      if (typeof freezeMs === "number" && freezeMs >= 0) {
        if (virtualClock < freezeMs) {
          virtualClock = Math.min(virtualClock + 100, freezeMs);
        }
      } else {
        virtualClock += 100;
      }
      if (typeof callback === "function") callback(virtualClock);
    });
    return id;
  };
  globalThis.cancelAnimationFrame = function () {};
  globalThis.ResizeObserver = function ResizeObserver(callback) {
    this.observe = function (target) {
      hostLog("debug", "[ResizeObserver.observe] " + (target && target.tagName));
      if (typeof callback === "function") {
        callback([{ target: target }]);
      }
    };
    this.unobserve = function () {};
    this.disconnect = function () {};
  };
  globalThis.console = {
    log: function () {
      var text = formatArgs(arguments);
      hostConsoleEntries.push({ level: "info", text: text });
      hostLog("info", text);
    },
    warn: function () {
      var text = formatArgs(arguments);
      hostConsoleEntries.push({ level: "warn", text: text });
      hostLog("warn", text);
    },
    error: function () {
      var text = formatArgs(arguments);
      hostConsoleEntries.push({ level: "error", text: text });
      hostLog("error", text);
    },
    debug: function () {
      var text = formatArgs(arguments);
      hostConsoleEntries.push({ level: "debug", text: text });
      hostLog("debug", text);
    },
  };
  globalThis.__createProbeContainer = function (id) {
    return ensureContainer(String(id || "g2-root"));
  };
  globalThis.__getHostConsoleEntries = function () {
    return hostConsoleEntries.slice();
  };
})();
