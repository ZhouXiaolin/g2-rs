// Source: antvis/G2 site/examples/general/interval/demo/column-maxwidth.ts
// Transpiled with the same Bun.Transpiler + import-strip pass as
// js/compare-batch.mjs, so this file is the exact source both sides run.

const chart = new Chart({
  container: "container",
  autoFit: true
});
chart.options({
  type: "interval",
  data: [{ letter: "A", frequency: 120 }],
  encode: { x: "letter", y: "frequency" },
  scale: { x: { padding: 0.5 } },
  style: {
    maxWidth: 200
  }
});
chart.render();
