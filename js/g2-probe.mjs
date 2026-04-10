import { Chart } from "@antv/g2";
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

function createContainer(options = {}) {
  const id = options.containerId || "g2-root";
  const width = options.width || 960;
  const height = options.height || 540;
  if (typeof globalThis.__createProbeContainer === "function") {
    const container = globalThis.__createProbeContainer(id);
    container.width = width;
    container.height = height;
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    hostLog("info", "using injected probe container", { id });
    return container;
  }
  hostLog("warn", "falling back to document.createElement('div')", { id });
  const container = document.createElement("div");
  container.width = width;
  container.height = height;
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  return container;
}

function configureChart(chart, options = {}) {
  chart
    .area()
    .data({
      type: "fetch",
      value:
        "https://gw.alipayobjects.com/os/bmw-prod/e58c9758-0a09-4527-aa90-fbf175b45925.json",
    })
    .transform({ type: "stackY", orderBy: "value" })
    .encode("x", (d) => new Date(d.date))
    .encode("y", "unemployed")
    .encode("color", "industry")
    .encode("shape", "smooth")
    .animate(false)
    .scale("x", { utc: true })
    .axis("x", { title: "Date" })
    .axis("y", { labelFormatter: "~s" })
    .legend("color", { size: 72, autoWrap: true, maxRows: 3, cols: 6 });

  hostLog("info", "configured stacked area chart");
}

export async function runG2Probe(options = {}) {
  hostLog("info", "runG2Probe:start", options);

  const renderer = createRenderer(options);
  const container = createContainer(options);
  const width = options.width || container.clientWidth || 960;
  const height = options.height || container.clientHeight || 540;

  hostLog("info", "creating chart", { width, height });
  const chart = new Chart({
    container,
    autoFit: true,
    renderer,
  });

  configureChart(chart, options);

  try {
    hostLog("info", "chart.render:begin");
    await chart.render();
    hostLog("info", "chart.render:done");
    const hasGetContext = typeof chart.getContext === "function";
    hostLog("info", "chart.context:inspect", { hasGetContext });
    const context = hasGetContext ? chart.getContext() : null;
    const gCanvas = context?.canvas;
    const hasCanvas = !!gCanvas;
    const hasCanvasRender = !!gCanvas && typeof gCanvas.render === "function";
    if (gCanvas && typeof gCanvas.render === "function") {
      hostLog("info", "canvas.render:begin");
      gCanvas.render({ reason: "probe-post-render" });
      hostLog("info", "canvas.render:done");
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
    const actualWidth = container.clientWidth || width;
    const actualHeight = container.clientHeight || height;
    return {
      ok: true,
      width: actualWidth,
      height: actualHeight,
      childCount: Array.isArray(container.children) ? container.children.length : 0,
      hasGetContext,
      hasCanvas,
      hasCanvasRender,
      fakeCanvasKitCommandCount: commands.length,
      fakeCanvasKitCommands: commands,
      fakeCanvasKitTraceCount: trace.length,
      fakeCanvasKitTraceTail: trace.slice(-20),
    };
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
