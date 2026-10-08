// Browser-side probe bundle: the SAME @antv/g2 + g-lite versions as the Rust
// probe (from js/node_modules), rendered with the real g-canvas 2D renderer.
// Replaces the official UMD in the compare harnesses so both sides run
// version-identical layout code.
import { Chart as G2Chart } from "@antv/g2";

function walkSpec(value, visit, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v) => walkSpec(v, visit, seen));
    return;
  }
  visit(value);
  Object.values(value).forEach((v) => walkSpec(v, visit, seen));
}

class Chart extends G2Chart {
  constructor(config = {}) {
    super(config);
    this.__rendered = false;
    globalThis.__lastChart = this;
  }

  render(...args) {
    if (!this.__static) {
      this.__static = true;
      const spec = this.options();
      let changed = 0;
      walkSpec(spec, (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const looks =
          "children" in node || "marks" in node || "encode" in node || ("type" in node && ("data" in node || "style" in node));
        if (!looks) return;
        if (node.animate !== false) {
          node.animate = false;
          changed += 1;
        }
        if (node.type === "timingKeyframe") {
          node.type = "view";
          if (Array.isArray(node.children) && node.children.length > 1) {
            node.children = [node.children[0]];
          }
          changed += 1;
        }
        if (node.interaction && Object.keys(node.interaction).length > 0) {
          node.interaction = {};
          changed += 1;
        }
        if (node.tooltip) {
          node.tooltip = false;
          changed += 1;
        }
        if (node.slider) {
          node.slider = false;
          changed += 1;
        }
        if (node.scrollbar) {
          node.scrollbar = false;
          changed += 1;
        }
      });
      this.options(spec);
    }
    this.__rendered = true;
    return super.render(...args);
  }
}

globalThis.G2 = { Chart };
