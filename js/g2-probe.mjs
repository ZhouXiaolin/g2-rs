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

function syncTicksOfDomainsFromZero(scales) {
  scales.forEach((scale) => scale.update({ nice: true }));
  const normalize = (d) => d / Math.pow(10, Math.ceil(Math.log(d) / Math.LN10));
  const maxes = scales.map((scale) => scale.getOptions().domain[1]);
  const normalized = maxes.map(normalize);
  const normalizedMax = Math.max(...normalized);
  for (let i = 0; i < scales.length; i += 1) {
    const scale = scales[i];
    const domain = scale.getOptions().domain;
    const t = maxes[i] / normalized[i];
    const newDomainMax = normalizedMax * t;
    scale.update({ domain: [domain[0], newDomainMax] });
  }
}

function buildSampleData() {
  return [
    { Month: "Jan", Evaporation: 2, Precipitation: 2.6, Temperature: 2 },
    { Month: "Feb", Evaporation: 4.9, Precipitation: 5.9, Temperature: 2.2 },
    { Month: "Mar", Evaporation: 7, Precipitation: 9, Temperature: 3.3 },
    { Month: "Apr", Evaporation: 23.2, Precipitation: 26.4, Temperature: 4.5 },
    { Month: "May", Evaporation: 25.6, Precipitation: 28.7, Temperature: 6.3 },
    { Month: "Jun", Evaporation: 76.7, Precipitation: 70.7, Temperature: 10.2 },
    { Month: "Jul", Evaporation: 135.6, Precipitation: 175.6, Temperature: 20.3 },
    { Month: "Aug", Evaporation: 162.2, Precipitation: 182.2, Temperature: 23.4 },
    { Month: "Sep", Evaporation: 32.6, Precipitation: 48.7, Temperature: 23 },
    { Month: "Oct", Evaporation: 20, Precipitation: 18.8, Temperature: 16.5 },
    { Month: "Nov", Evaporation: 6.4, Precipitation: 6, Temperature: 12 },
    { Month: "Dec", Evaporation: 3.3, Precipitation: 2.3, Temperature: 6.2 },
  ];
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
  const data = options.data || buildSampleData();
  chart.data(data);

  chart
    .line()
    .encode("x", "Month")
    .encode("y", "Temperature")
    .encode("color", "#EE6666")
    .encode("shape", "smooth")
    .animate(false)
    .scale("y", {
      independent: true,
      groupTransform: syncTicksOfDomainsFromZero,
    })
    .axis("y", {
      title: "Temperature (°C)",
      grid: null,
      titleFill: "#EE6666",
    });

  chart
    .interval()
    .encode("x", "Month")
    .encode("y", "Evaporation")
    .encode("color", "#5470C6")
    .animate(false)
    .scale("y", { independent: true })
    .style("fillOpacity", 0.8)
    .axis("y", {
      position: "right",
      title: "Evaporation (ml)",
      titleFill: "#5470C6",
    });

  chart
    .line()
    .encode("x", "Month")
    .encode("y", "Precipitation")
    .encode("color", "#91CC75")
    .animate(false)
    .scale("y", { independent: true })
    .style("lineWidth", 2)
    .style("lineDash", [2, 2])
    .axis("y", {
      position: "right",
      title: "Precipitation (ml)",
      grid: null,
      titleFill: "#91CC75",
    });

  hostLog("info", "configured combo chart", { rows: data.length });
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
