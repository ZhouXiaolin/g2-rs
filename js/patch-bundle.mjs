// Post-esbuild patch: g-canvaskit leaves rect-shaped G-element patterns as an
// empty branch (never rendered). Route them to our rasterizer hook instead.
// ponytail: string patch on the built bundle; if upstream changes the text this
// fails loudly and the patch needs a one-line update.
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("./g2-bundle.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let src = readFileSync(path, "utf8");
const needle = 'else if (image.nodeName === "rect") ;';
if (!src.includes(needle)) {
  throw new Error("pattern patch target not found in g2-bundle.js");
}
src = src.replace(
  needle,
  'else if (image.nodeName === "rect") { src = globalThis.__renderRectPattern ? globalThis.__renderRectPattern(image) : void 0; }',
);

// g-lite's parseColor is not idempotent: re-parsing an already-parsed value
// (gradient array, CSSRGB) falls through to a transparent-black CSSRGB. Style
// properties get re-parsed on updates, so parsed objects must pass through.
const parseColorNeedle = "var parseColor = memoize2(function(colorStr) {";
const parseColorPatch =
  'var parseColor = memoize2(function(colorStr) {\n    if (colorStr && typeof colorStr === "object") return colorStr;';
if (!src.includes(parseColorPatch)) {
  if (!src.includes(parseColorNeedle)) {
    throw new Error("parseColor patch target not found in g2-bundle.js");
  }
  src = src.replace(parseColorNeedle, parseColorPatch);
}
writeFileSync(path, src);
console.log("patched rect-pattern branch + parseColor idempotency");
