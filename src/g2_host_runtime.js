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
    this.width = 0;
    this.height = 0;
    this._contexts = {};
  }

  CanvasElement.prototype = Object.create(Element.prototype);
  CanvasElement.prototype.constructor = CanvasElement;

  function Canvas2DContext(canvas) {
    this.canvas = canvas;
    this.font = "12px sans-serif";
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
    this.fillStyle = "#000";
    this._lastTextY = 0;
    this._lastFontSize = 12;
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

  Canvas2DContext.prototype.clearRect = function () {
    hostLog("debug", "[2d.clearRect]");
  };

  Canvas2DContext.prototype.fillRect = function () {
    hostLog("debug", "[2d.fillRect]");
  };

  Canvas2DContext.prototype.fillText = function (_text, _x, y) {
    var match = /(\d+(?:\.\d+)?)px/.exec(String(this.font || ""));
    this._lastFontSize = match ? Number(match[1]) : 12;
    this._lastTextY = Number(y) || 0;
    hostLog("debug", "[2d.fillText]");
  };

  Canvas2DContext.prototype.getImageData = function (_x, _y, width, height) {
    var w = Math.max(1, Number(width) || this.canvas.width || 1);
    var h = Math.max(1, Number(height) || this.canvas.height || 1);
    var data = new Uint8ClampedArray(w * h * 4);

    for (var i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }

    var top = Math.max(0, Math.floor(this._lastTextY - this._lastFontSize * 0.8));
    var bottom = Math.min(h - 1, Math.ceil(this._lastTextY + this._lastFontSize * 0.2));
    for (var row = top; row <= bottom; row += 1) {
      var idx = row * w * 4;
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
      data[idx + 3] = 255;
    }

    hostLog("debug", "[2d.getImageData]");
    return { data: data };
  };

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
  var maxRafCallbacks = 256;
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
      return Date.now();
    },
  };
  globalThis.getComputedStyle = function (element) {
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
      if (typeof callback === "function") callback(0);
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
