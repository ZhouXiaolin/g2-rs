import { Chart as BaseChart } from "@antv/g2";
import { Renderer as CanvasKitRenderer } from "./fake-g-canvaskit.mjs";

function hostLog(level, message, extra) {
  const suffix =
    extra === undefined
      ? ""
      : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  if (typeof globalThis.__rust_log === "function") {
    globalThis.__rust_log(String(level), `${String(message)}${suffix}`);
  }
}

function createRenderer(options = {}) {
  const wasmDir =
    options.wasmDir || "https://unpkg.com/canvaskit-wasm@0.34.0/bin/";
  hostLog("info", "creating canvaskit renderer", { wasmDir });
  return new CanvasKitRenderer({ wasmDir });
}

function ensureContainer(options = {}) {
  const id = options.containerId || "container";
  const width = options.width || 960;
  const height = options.height || 540;

  let container = document.getElementById(id);
  if (!container && typeof globalThis.__createProbeContainer === "function") {
    container = globalThis.__createProbeContainer(id);
  }
  if (!container) {
    container = document.createElement("div");
    container.id = id;
    if (document.registerElement) {
      document.registerElement(id, container);
    }
    if (document.body?.appendChild) {
      document.body.appendChild(container);
    }
  }

  container.width = width;
  container.height = height;
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  hostLog("info", "using probe container", { id, width, height });
  return container;
}

function sanitizeUserScript(source) {
  return String(source || "")
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, "")
    .replace(/^\s*export\s+/gm, "")
    .trim();
}

function createManagedChartClass(defaultContainer, runtimeOptions = {}) {
  return class ProbeChart extends BaseChart {
    constructor(config = {}) {
      const next = { ...config };
      if (!next.container) {
        next.container = defaultContainer;
      } else if (typeof next.container === "string") {
        next.container =
          document.getElementById(next.container) || defaultContainer;
      }
      // Fresh Renderer per chart: g-lite rebinds shared plugin instances to the
      // newest canvas, so a shared Renderer breaks every chart but the last.
      if (!next.renderer) {
        next.renderer = createRenderer(runtimeOptions);
      }
      super(next);
      this.__probeRenderCalled = false;
      this.__probeRenderPromise = null;
      this.__probeRenderSettled = false;
      this.__probeStaticModeApplied = false;
      globalThis.__lastProbeChart = this;
      (globalThis.__lastProbeCharts = globalThis.__lastProbeCharts || []).push(this);
    }

    render(...args) {
      applyStaticMode(this, runtimeOptions);
      this.__probeRenderCalled = true;
      this.__probeRenderSettled = false;
      const promise = Promise.resolve(super.render(...args));
      this.__probeRenderPromise = promise.finally(() => {
        this.__probeRenderSettled = true;
      });
      return this.__probeRenderPromise;
    }

    interaction(...args) {
      hostLog("info", "chart.interaction:skip", args);
      return this;
    }
  };
}

function walkOptionsTree(value, visit, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) walkOptionsTree(item, visit, seen);
    return;
  }

  visit(value);
  for (const item of Object.values(value)) {
    walkOptionsTree(item, visit, seen);
  }
}

function applyStaticMode(chart, options = {}) {
  if (options.staticMode === false) return;
  if (!chart || typeof chart.options !== "function") return;
  if (chart.__probeStaticModeApplied) return;

  const spec = chart.options();
  let changed = 0;

  walkOptionsTree(spec, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;

    // Only marks/views (encode/children/marks/data holders) take `animate`.
    // Polluting transform/data nodes (e.g. {type:'binX'}) leaks `animate: false`
    // into aggregate options -> "Unknown reducer: false".
    const looksLikeSpecNode =
      "children" in node ||
      "marks" in node ||
      "encode" in node ||
      ("type" in node && ("data" in node || "style" in node));
    if (!looksLikeSpecNode) return;

    if (node.animate !== false) {
      node.animate = false;
      changed += 1;
    }

    // timingKeyframe plays children as a timed sequence; freeze both sides at
    // the first keyframe so the probe and the browser agree deterministically.
    if (node.type === "timingKeyframe" && Array.isArray(node.children) && node.children.length > 1) {
      node.children = [node.children[0]];
      changed += 1;
    }

    if ("interaction" in node && node.interaction && Object.keys(node.interaction).length > 0) {
      node.interaction = {};
      changed += 1;
    }

    if ("tooltip" in node && node.tooltip !== false) {
      node.tooltip = false;
      changed += 1;
    }

    if ("slider" in node && node.slider) {
      node.slider = false;
      changed += 1;
    }

    if ("scrollbar" in node && node.scrollbar) {
      node.scrollbar = false;
      changed += 1;
    }
  });

  chart.options(spec);
  chart.__probeStaticModeApplied = true;
  if (changed > 0) {
    hostLog("info", "chart.staticMode:applied", { changed });
  }
}

async function waitForRenderableState(chart) {
  if (chart.__probeRenderPromise) {
    await chart.__probeRenderPromise;
  }
  for (let i = 0; i < 32; i++) {
    await Promise.resolve();
  }
}

async function executeUserScript(userScript, options = {}) {
  const container = ensureContainer(options);
  const Chart = createManagedChartClass(container, options);
  const source = sanitizeUserScript(userScript);

  if (!source) {
    throw new Error("G2 script is empty");
  }

  globalThis.__lastProbeChart = null;
  globalThis.__lastProbeCharts = [];

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  // Collision-proof wrapper param names: demos commonly declare `const options`,
  // and AsyncFunction bodies are strict mode, so a shadowed param is fatal.
  const fn = new AsyncFunction(
    "Chart",
    "__probeOptions",
    "__probeHostLog",
    `${source}

return (typeof chart !== "undefined" ? chart : globalThis.__lastProbeChart);`,
  );

  const chart = await fn(Chart, options, hostLog);
  if (!chart || typeof chart.render !== "function") {
    // Demos may create the chart inside fetch().then(...) callbacks; drain
    // microtasks so those async chains run before giving up (no host timers).
    for (let i = 0; i < 400 && !globalThis.__lastProbeChart; i++) {
      await Promise.resolve();
    }
  }
  const resolvedChart = chart || globalThis.__lastProbeChart;
  if (!resolvedChart || typeof resolvedChart.render !== "function") {
    throw new Error("script did not create a chart");
  }

  if (resolvedChart.__probeRenderCalled) {
    await waitForRenderableState(resolvedChart);
  } else {
    hostLog("info", "chart.render:auto");
    resolvedChart.render();
    await waitForRenderableState(resolvedChart);
  }

  return { chart: resolvedChart, container };
}

function countDrawableObjects(object) {
  if (!object) return 0;
  const drawable =
    typeof object.nodeName === "string" &&
    object.nodeName !== "group" &&
    object.nodeName !== "g" &&
    !object.nodeName.startsWith("$");
  let count = drawable ? 1 : 0;
  const children = Array.isArray(object.childNodes) ? object.childNodes : [];
  for (const child of children) {
    count += countDrawableObjects(child);
  }
  return count;
}

// Block-layout approximation so multi-chart demos composite correctly:
// children stack vertically, canvases fill their container's width.
function computeLayerLayout(container, layers) {
  const byCanvas = new Map();
  for (const layer of layers) {
    if (layer.canvas) byCanvas.set(layer.canvas, layer);
  }
  if (byCanvas.size === 0) return;

  function parsePx(value) {
    const n = Number(typeof value === "string" ? parseFloat(value) : value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Returns the block height consumed by el starting at offsetY.
  function walk(el, offsetY) {
    let cursor = offsetY;
    for (const child of el.children || []) {
      const tag = String(child.tagName || "").toLowerCase();
      if (tag === "canvas") {
        const layer = byCanvas.get(child);
        const h = parsePx(child.__cssHeight) || parsePx(child.height) || 0;
        if (layer) {
          layer.x = 0;
          layer.y = cursor;
        }
        cursor += h;
      } else {
        cursor = walk(child, cursor);
      }
    }
    return offsetY + Math.max(parsePx(el.style && el.style.height), cursor - offsetY);
  }

  walk(container, 0);
}

function collectRenderResult(chart, container, options = {}) {
  const hasGetContext = typeof chart.getContext === "function";
  const context = hasGetContext ? chart.getContext() : null;
  const gCanvas = context?.canvas;
  const hasCanvas = !!gCanvas;
  const hasCanvasRender = !!gCanvas && typeof gCanvas.render === "function";

  const generationBefore =
    typeof globalThis.__g2EndFrameGeneration === "number"
      ? globalThis.__g2EndFrameGeneration
      : 0;

  if (gCanvas && typeof gCanvas.render === "function") {
    // Re-render every probe chart so each layer's LAST complete frame reflects
    // its final scene (G2 only redraws canvases whose chart changed).
    const charts = Array.isArray(globalThis.__lastProbeCharts)
      ? globalThis.__lastProbeCharts.filter((c) => c && typeof c.getContext === "function")
      : [];
    for (const probeChart of charts) {
      try {
        const ctx = probeChart.getContext();
        const probeCanvas = ctx && ctx.canvas;
        if (probeCanvas && typeof probeCanvas.render === "function") {
          probeCanvas.render({ reason: "probe-final-render" });
        }
      } catch (renderError) {
        hostLog("warn", "probe-final-render:failed", String(renderError));
      }
    }
    if (!charts.length) {
      gCanvas.render({ reason: "probe-final-render" });
    }
  } else {
    hostLog("warn", "canvas.render:missing", { hasCanvas, hasCanvasRender });
  }

  const generationAfter =
    typeof globalThis.__g2EndFrameGeneration === "number"
      ? globalThis.__g2EndFrameGeneration
      : 0;

  const trace =
    typeof globalThis.__getFakeCanvasKitTrace === "function"
      ? globalThis.__getFakeCanvasKitTrace()
      : [];
  const commands =
    typeof globalThis.__getFakeCanvasKitCommands === "function"
      ? globalThis.__getFakeCanvasKitCommands()
      : [];
  const rawLayers =
    typeof globalThis.__getFakeCanvasKitLayers === "function"
      ? globalThis.__getFakeCanvasKitLayers()
      : null;
  if (rawLayers) {
    computeLayerLayout(container, rawLayers);
  }
  const layers = rawLayers
    ? rawLayers.map((layer) => ({
        index: layer.index,
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        commands: layer.commands,
      }))
    : [];
  const width = options.width || container.clientWidth || 960;
  const height = options.height || container.clientHeight || 540;

  const drawCommandCount = commands.filter((c) =>
    typeof c.kind === "string" && c.kind.startsWith("draw")
  ).length;

  const leafCount =
    typeof gCanvas?.document?.documentElement !== "undefined"
      ? countDrawableObjects(gCanvas.document.documentElement)
      : -1;

  if (generationAfter <= generationBefore) {
    hostLog("warn", "completeness:no-new-endFrame", {
      generationBefore,
      generationAfter,
    });
  }
  if (leafCount > 0 && drawCommandCount === 0) {
    hostLog("warn", "completeness:suspect", { leafCount, drawCommandCount });
  }

  hostLog("info", "completeness:report", {
    endFrameGeneration: generationAfter,
    drawCommandCount,
    leafCount,
    totalCommandCount: commands.length,
  });

  return {
    ok: true,
    width,
    height,
    childCount: Array.isArray(container.children) ? container.children.length : 0,
    hasGetContext,
    hasCanvas,
    hasCanvasRender,
    layers,
    fakeCanvasKitCommandCount: commands.length,
    fakeCanvasKitCommands: layers && layers.length ? [] : commands,
    fakeCanvasKitTraceCount: trace.length,
    fakeCanvasKitTraceTail: trace.slice(-20),
  };
}

function collectCurrentG2ProbeState(options = {}) {
  const chart = globalThis.__lastProbeChart;
  const container =
    document.getElementById(options.containerId || "container") || null;
  if (!chart || !container) {
    return null;
  }
  return collectRenderResult(chart, container, options);
}

export async function runG2Probe(userScript, options = {}) {
  hostLog("info", "runG2Probe:start", options);
  try {
    const { chart, container } = await executeUserScript(userScript, options);
    return collectRenderResult(chart, container, options);
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${String(error.stack || "").split("\n").slice(0, 6).join("\n")}`
        : String(error);
    hostLog("error", "chart.render:failed", message);
    // Degrade like the browser harness does: the truth side catches script
    // errors and screenshots whatever rendered, so emit current state instead
    // of failing the whole probe (e.g. demos referencing stripped imports).
    const chart = globalThis.__lastProbeChart;
    const container =
      document.getElementById(options.containerId || "container") || null;
    if (chart && container) {
      try {
        // The script may have thrown right after chart.render(); let the
        // render's microtask chain settle before collecting the frame.
        if (chart.__probeRenderPromise) {
          await chart.__probeRenderPromise.catch(() => {});
        }
        for (let i = 0; i < 32; i++) {
          await Promise.resolve();
        }
        const partial = collectRenderResult(chart, container, options);
        return { ...partial, ok: false, error: message };
      } catch (collectError) {
        hostLog("error", "chart.collect:failed", String(collectError));
      }
    }
    const width = options.width || 960;
    const height = options.height || 540;
    return {
      ok: false,
      error: message,
      width,
      height,
      childCount: 0,
      hasGetContext: false,
      hasCanvas: false,
      hasCanvasRender: false,
      layers: [],
      fakeCanvasKitCommandCount: 0,
      fakeCanvasKitCommands: [],
      fakeCanvasKitTraceCount: 0,
      fakeCanvasKitTraceTail: [],
    };
  }
}

globalThis.runG2Probe = runG2Probe;
globalThis.collectCurrentG2ProbeState = collectCurrentG2ProbeState;
