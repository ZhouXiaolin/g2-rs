// Source: antvis/G2 site/examples/general/mini/demo/area.ts
// Transpiled with the same Bun.Transpiler + import-strip pass as
// js/compare-batch.mjs, so this file is the exact source both sides run.

const data = [
  264,
  417,
  438,
  887,
  309,
  397,
  550,
  575,
  563,
  430,
  525,
  592,
  492,
  467,
  513,
  546,
  983,
  340,
  539,
  243,
  226,
  192
];
const chart = new Chart({
  container: "container",
  width: 480,
  height: 80
});
chart.options({
  type: "area",
  data,
  interaction: {
    tooltip: {
      render: (e, { title, items }) => items[0].value
    }
  },
  encode: { x: (_, idx) => idx, y: (d) => d, shape: "smooth" },
  scale: { y: { zero: true } },
  style: {
    fill: "linear-gradient(-90deg, white 0%, darkgreen 100%)",
    fillOpacity: 0.6
  },
  animate: { enter: { type: "fadeIn" } },
  axis: false
});
chart.render();
