// A/B a custom chart spec (view-class static normalization) between the
// version-matched browser bundle and g2-rs. Usage: bun dbg-spec.mjs <spec.js>
// The spec file body runs with `Chart` in scope; create + render a chart.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const execFileP = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const ART = resolve(ROOT, "artifacts/dbg-spec");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const G2_RS = resolve(ROOT, "target/release/g2-rs.exe");
const WIDTH = 960;
const HEIGHT = 540;
const THRESHOLD = 16;
const NAME = resolve(process.argv[2] || "spec").split(/[\\/]/).pop().replace(/\.js$/, "");

const SEEDED_RANDOM_PRELUDE = `
(function () {
  let seed = 42;
  Math.random = function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
`;

async function main() {
  mkdirSync(ART, { recursive: true });
  const spec = readFileSync(resolve(ROOT, process.argv[2]), "utf8");

  const browserBundle = readFileSync(resolve(ROOT, "js/g2-browser-bundle.js"), "utf8")
    .replace(/<\/script>/gi, "<\\/script>");
  const js = (SEEDED_RANDOM_PRELUDE + spec).replace(/<\/script>/gi, "<\\/script>");

  const htmlPath = resolve(ART, `_${NAME}.html`);
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<div id="errlog" style="position:fixed;top:0;left:0;z-index:9999;color:red;font:14px monospace;max-width:100%;white-space:pre-wrap"></div>
<div id="container" style="width:${WIDTH}px;height:${HEIGHT}px"></div>
<script>${browserBundle}</script>
<script>
function L(m) { document.getElementById("errlog").textContent += m + "\\n"; }
window.onerror = function (m, s, l, c) { L("ERR: " + m + " @" + l + ":" + c); return true; };
window.onunhandledrejection = function (e) { L("REJECTION: " + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)); };
const Chart = globalThis.G2.Chart;
(async function () {
  ${js}
  const c = globalThis.__lastChart;
  try {
    const cc = c && c.getContext && c.getContext().canvas.getConfig();
    L("SIZE=" + cc.width + "x" + cc.height);
  } catch (e) {}
  L("HARNESS-OK chart=" + (c ? "yes" : "no"));
  await new Promise((done) => {
    const poll = () => {
      const cv = document.querySelector("#container canvas");
      if (cv) setTimeout(done, 1200); else setTimeout(poll, 50);
    };
    poll();
  });
})();
</script></body></html>`,
  );

  const shotPath = resolve(ART, `${NAME}-chrome.png`);
  const profileDir = resolve(ART, "_edge-profile");
  await execFileP(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${shotPath}`,
    "--virtual-time-budget=30000",
    pathToFileURL(htmlPath).href,
  ], { timeout: 45_000, stdio: "ignore" });
  rmSync(profileDir, { recursive: true, force: true });

  const transpiledPath = resolve(ART, `${NAME}-transpiled.js`);
  writeFileSync(transpiledPath, SEEDED_RANDOM_PRELUDE + spec);
  execFileSync(G2_RS, ["--input", transpiledPath, "--name", NAME, "--output-dir", "artifacts/dbg-spec"],
    { cwd: ROOT, timeout: 45_000, stdio: "pipe" });

  const a = PNG.sync.read(readFileSync(resolve(ART, `${NAME}-frame.png`)));
  const b = PNG.sync.read(readFileSync(shotPath));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`${NAME}: SIZE MISMATCH`);
    return;
  }
  const diffPng = new PNG({ width: a.width, height: a.height });
  let diffPixels = 0, sumDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    sumDelta += d;
    if (d > THRESHOLD) {
      diffPixels += 1;
      diffPng.data[i] = 255; diffPng.data[i + 1] = 0; diffPng.data[i + 2] = 0;
    } else {
      const g = 255 - Math.min(255, d * 8);
      diffPng.data[i] = g; diffPng.data[i + 1] = g; diffPng.data[i + 2] = g;
    }
    diffPng.data[i + 3] = 255;
  }
  writeFileSync(resolve(ART, `${NAME}-diff.png`), PNG.sync.write(diffPng));
  console.log(`${NAME}: diff>16 ${((diffPixels / (a.width * a.height)) * 100).toFixed(2)}% meanDelta=${(sumDelta / (a.width * a.height)).toFixed(2)} avg_p8=${((sumDelta / (a.width * a.height) / 255) * 100).toFixed(2)}%`);
  console.log(`  artifacts/dbg-spec/${NAME}-{frame,chrome,diff}.png`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
