const chart = new Chart({
  container: "container",
  autoFit: true,
});

chart
  .interval()
  .coordinate({ transform: [{ type: "theta" }] })
  .data([
    { name: "A", value: 40 },
    { name: "B", value: 21 },
    { name: "C", value: 17 },
    { name: "D", value: 13 },
    { name: "E", value: 9 },
  ])
  .transform({ type: "stackY" })
  .encode("y", "value")
  .encode("color", "name")
  .style("stroke", "white")
  .style("inset", 1)
  .animate(false)
  .legend("color", { position: "right" });

chart.render();
