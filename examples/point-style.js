// Source: antvis/G2 site/examples/general/point/demo/point-style.ts
// Transpiled with the same Bun.Transpiler + import-strip pass as
// js/compare-batch.mjs, so this file is the exact source both sides run.

const chart = new Chart({ container: "container" });
chart.options({
  type: "point",
  style: {
    fill: "skyblue",
    fillOpacity: 0.9,
    stroke: "#FADC7C",
    lineWidth: 3,
    lineDash: [1, 2],
    strokeOpacity: 0.95,
    opacity: 0.9,
    shadowColor: "black",
    shadowBlur: 10,
    shadowOffsetX: 5,
    shadowOffsetY: 5,
    cursor: "pointer"
  },
  height: 350,
  data: [{ x: 0.5, y: 0.5 }],
  encode: {
    x: "x",
    y: "y",
    size: 10,
    shape: "point"
  },
  scale: {
    x: { domain: [0, 1], nice: true },
    y: { domain: [0, 1], nice: true }
  }
});
chart.render();
