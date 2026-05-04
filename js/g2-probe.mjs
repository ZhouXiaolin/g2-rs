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

function createManagedChartClass(renderer, defaultContainer, runtimeOptions = {}) {
  return class ProbeChart extends BaseChart {
    constructor(config = {}) {
      const next = { ...config };
      if (!next.container) {
        next.container = defaultContainer;
      } else if (typeof next.container === "string") {
        next.container =
          document.getElementById(next.container) || defaultContainer;
      }
      if (!next.renderer) {
        next.renderer = renderer;
      }
      super(next);
      this.__probeRenderCalled = false;
      this.__probeRenderPromise = null;
      this.__probeRenderSettled = false;
      this.__probeStaticModeApplied = false;
      globalThis.__lastProbeChart = this;
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

    const looksLikeSpecNode =
      "type" in node ||
      "children" in node ||
      "marks" in node ||
      "encode" in node ||
      "data" in node;
    if (!looksLikeSpecNode) return;

    if (node.animate !== false) {
      node.animate = false;
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
  for (let i = 0; i < 256; i += 1) {
    await Promise.resolve();
    const commands =
      typeof globalThis.__getFakeCanvasKitCommands === "function"
        ? globalThis.__getFakeCanvasKitCommands()
        : [];
    if (commands.length > 1 || chart.__probeRenderSettled) {
      return;
    }
  }
}

async function executeUserScript(userScript, options = {}) {
  const renderer = createRenderer(options);
  const container = ensureContainer(options);
  const Chart = createManagedChartClass(renderer, container, options);
  const source = sanitizeUserScript(userScript);

  if (!source) {
    throw new Error("G2 script is empty");
  }

  globalThis.__lastProbeChart = null;

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    "Chart",
    "options",
    "hostLog",
    `${source}

return (typeof chart !== "undefined" ? chart : globalThis.__lastProbeChart);`,
  );

  const chart = await fn(Chart, options, hostLog);
  if (!chart || typeof chart.render !== "function") {
    throw new Error("script did not create a chart");
  }

  if (chart.__probeRenderCalled) {
    await waitForRenderableState(chart);
  } else {
    hostLog("info", "chart.render:auto");
    chart.render();
    await waitForRenderableState(chart);
  }

  return { chart, container };
}

function collectRenderResult(chart, container, options = {}) {
  const hasGetContext = typeof chart.getContext === "function";
  const context = hasGetContext ? chart.getContext() : null;
  const gCanvas = context?.canvas;
  const hasCanvas = !!gCanvas;
  const hasCanvasRender = !!gCanvas && typeof gCanvas.render === "function";
  if (gCanvas && typeof gCanvas.render === "function") {
    gCanvas.render({ reason: "probe-post-render" });
  } else {
    hostLog("warn", "canvas.render:missing", { hasCanvas, hasCanvasRender });
  }

  const trace =
    typeof globalThis.__getFakeCanvasKitTrace === "function"
      ? globalThis.__getFakeCanvasKitTrace()
      : [];
  const commands =
    typeof globalThis.__getFakeCanvasKitCommands === "function"
      ? globalThis.__getFakeCanvasKitCommands()
      : [];
  const width = options.width || container.clientWidth || 960;
  const height = options.height || container.clientHeight || 540;

  return {
    ok: true,
    width,
    height,
    childCount: Array.isArray(container.children) ? container.children.length : 0,
    hasGetContext,
    hasCanvas,
    hasCanvasRender,
    fakeCanvasKitCommandCount: commands.length,
    fakeCanvasKitCommands: commands,
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
    const trace =
      typeof globalThis.__getFakeCanvasKitTrace === "function"
        ? globalThis.__getFakeCanvasKitTrace()
        : [];
    const message =
      error && typeof error === "object" && "stack" in error
        ? String(error.stack)
        : String(error);
    hostLog("error", "chart.render:failed", message);
    hostLog("error", "fakeCanvasKit.trace", {
      count: trace.length,
      tail: trace.slice(-20),
    });
    throw error;
  }
}

globalThis.runG2Probe = runG2Probe;
globalThis.collectCurrentG2ProbeState = collectCurrentG2ProbeState;
