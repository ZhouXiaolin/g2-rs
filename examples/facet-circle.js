// Source: antvis/G2 site/examples/composition/facet/demo/circle.ts
// Transpiled with the same Bun.Transpiler + import-strip pass as
// js/compare-batch.mjs, so this file is the exact source both sides run.

const M = [
  "Jan.",
  "Feb.",
  "Mar.",
  "Apr.",
  "May",
  "Jun.",
  "Jul.",
  "Aug.",
  "Sept.",
  "Oct.",
  "Nov.",
  "Dec."
];
const N = ["A", "B", "C", "D"];
const data = M.flatMap((month) => N.map((name) => ({
  month,
  name,
  value: Math.random()
})));
const chart = new Chart({
  container: "container",
  width: 480,
  height: 480
});
chart.options({
  type: "facetCircle",
  data,
  encode: { position: "month" },
  children: [
    { type: "interval", encode: { x: "name", y: "value", color: "name" } }
  ]
});
chart.render();
