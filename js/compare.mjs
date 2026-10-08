// Pixel-diff a G2 example: real browser (Edge headless) vs our g2-rs pipeline.
// Usage: bun compare.mjs <example.js> [name]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const example = process.argv[2];
const name = process.argv[3] || resolve(example).split(/[\\/]/).pop().replace(/\.js$/, "");
const ROOT = resolve(import.meta.dirname, "..");
const ART = resolve(ROOT, "artifacts");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const G2_RS = ["target/release/g2-rs.exe", "target/debug/g2-rs.exe"]
  .map((p) => resolve(ROOT, p))
  .find((p) => existsSync(p)) || resolve(ROOT, "target/debug/g2-rs.exe");
const WIDTH = 960;
const HEIGHT = 540;
const THRESHOLD = 16; // max-channel delta above this counts as "different"

mkdirSync(ART, { recursive: true });

// 1. Harness HTML: real G2 UMD + the same example script inlined.
const g2umd = readFileSync(resolve(ROOT, "js/node_modules/@antv/g2/dist/g2.min.js"), "utf8")
  .replace(/<\/script>/gi, "<\\/script>");
const script = readFileSync(resolve(ROOT, example), "utf8").replace(/<\/script>/gi, "<\\/script>");
const harnessPath = resolve(ART, "_harness.html");
writeFileSync(
  harnessPath,
  `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<div id="container" style="width:${WIDTH}px;height:${HEIGHT}px"></div>
<script>${g2umd}</script>
<script>
const Chart = G2.Chart;
(async function () {
  ${script}
  await new Promise((done) => {
    const poll = () => {
      const c = document.querySelector("#container canvas");
      if (c) setTimeout(done, 1500); else setTimeout(poll, 50);
    };
    poll();
  });
  document.title = "READY";
})();
</script></body></html>`
);

// 2. Edge headless screenshot.
execFileSync(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  `--user-data-dir=${resolve(ART, "_edge-profile")}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  `--screenshot=${resolve(ART, `${name}-chrome.png`)}`,
  "--virtual-time-budget=15000",
  pathToFileURL(harnessPath).href,
], { stdio: "ignore", timeout: 60_000 });
rmSync(resolve(ART, "_edge-profile"), { recursive: true, force: true });

// 3. Our pipeline.
execFileSync(G2_RS, ["--input", resolve(ROOT, example), "--name", name, "--output-dir", "artifacts"], { cwd: ROOT });

// 4. Pixel diff.
const a = PNG.sync.read(readFileSync(resolve(ART, `${name}-frame.png`)));     // ours
const b = PNG.sync.read(readFileSync(resolve(ART, `${name}-chrome.png`)));    // browser
if (a.width !== b.width || a.height !== b.height) {
  throw new Error(`size mismatch: ours ${a.width}x${a.height} vs chrome ${b.width}x${b.height}`);
}

const diffPng = new PNG({ width: a.width, height: a.height });
let diffPixels = 0;
let sumDelta = 0;
for (let i = 0; i < a.data.length; i += 4) {
  const dr = Math.abs(a.data[i] - b.data[i]);
  const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
  const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
  const d = Math.max(dr, dg, db);
  sumDelta += d;
  if (d > THRESHOLD) {
    diffPixels += 1;
    diffPng.data[i] = 255; diffPng.data[i + 1] = 0; diffPng.data[i + 2] = 0;
  } else {
    const g = 255 - Math.min(255, d * 8); // near-match darkens slightly
    diffPng.data[i] = g; diffPng.data[i + 1] = g; diffPng.data[i + 2] = g;
  }
  diffPng.data[i + 3] = 255;
}
writeFileSync(resolve(ART, `${name}-diff.png`), PNG.sync.write(diffPng));

const total = a.width * a.height;
const pct = ((diffPixels / total) * 100).toFixed(2);
const mean = (sumDelta / total).toFixed(2);
console.log(`${name}: diff>${THRESHOLD} ${pct}% (${diffPixels}/${total} px), meanDelta=${mean}`);
console.log(`  ours:   artifacts/${name}-frame.png`);
console.log(`  edge:   artifacts/${name}-chrome.png`);
console.log(`  diff:   artifacts/${name}-diff.png`);
