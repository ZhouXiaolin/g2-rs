import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

function texToSVG(latex, display) {
  var tex = new TeX({ packages: AllPackages });
  var svg = new SVG({ fontCache: "local" });
  var doc = mathjax.document("", { InputJax: tex, OutputJax: svg });
  var node = doc.convert(latex, { display: display !== false });

  var svgString = adaptor.outerHTML(node);
  var match = svgString.match(/<svg[^>]*>[\s\S]*<\/svg>/);
  if (!match) throw new Error("No SVG output");
  var svgTag = match[0];

  if (svgTag.includes("data-mjx-error")) {
    var errMatch = svgTag.match(/title="([^"]+)"/);
    throw new Error(errMatch ? errMatch[1] : "Unknown math error");
  }
  return svgTag;
}

globalThis.texToSVG = texToSVG;
