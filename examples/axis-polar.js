// Source: antvis/G2 site/examples/component/axis/demo/axis-polar.ts
// Transpiled with the same Bun.Transpiler + import-strip pass as
// js/compare-batch.mjs, so this file is the exact source both sides run.

const chart = new Chart({
  container: "container"
});
chart.options({
  type: "view",
  coordinate: { type: "polar" },
  scale: {
    x: {
      type: "linear",
      domain: [5, 10],
      range: [0, 1]
    },
    y: {
      type: "linear",
      domain: [5, 10],
      range: [1, 0]
    }
  },
  children: [
    {
      type: "axisX",
      title: "AxisX",
      tickFilter: (_, i, ticks) => i && i !== ticks.length - 1
    },
    {
      type: "axisY",
      title: "AxisY",
      style: { labelFontSize: 14, gridLineWidth: 10, gridStroke: "red" }
    }
  ]
});
chart.render();
