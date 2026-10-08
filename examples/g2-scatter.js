const chart = new Chart({
  container: "container",
  autoFit: true,
});

chart
  .point()
  .data([
    { x: 1, y: 4.5 }, { x: 2, y: 3.2 }, { x: 3, y: 5.1 },
    { x: 4, y: 2.8 }, { x: 5, y: 6.3 }, { x: 6, y: 4.0 },
    { x: 7, y: 7.2 }, { x: 8, y: 5.5 }, { x: 9, y: 6.8 },
    { x: 10, y: 8.1 },
  ])
  .encode("x", "x")
  .encode("y", "y")
  .encode("size", 8)
  .style("fill", "#5B8FF9")
  .animate(false);

chart.render();
