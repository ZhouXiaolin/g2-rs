// Debug a single gallery example with the exact batch harness, isolated output.
// Usage: bun dbg-one.mjs <id-substring>   e.g. bun dbg-one.mjs vector/demo/wind
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve, join, relative, sep } from "node:path";
import { PNG } from "pngjs";

const execFileP = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const REPO = resolve(ROOT, ".g2-repo/site/examples");
const ART = resolve(ROOT, "artifacts/dbg");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const G2_RS = (() => {
  for (const p of ["target/release/g2-rs.exe", "target/debug/g2-rs.exe"]) {
    if (existsSync(resolve(ROOT, p))) return resolve(ROOT, p);
  }
  throw new Error("g2-rs.exe not built");
})();
const WIDTH = 960;
const HEIGHT = 540;
const THRESHOLD = 16;
const FILTER = process.argv[2] || "";
const NAME = FILTER.replaceAll("/", "-");

const { default: Bun } = { default: globalThis.Bun };
const transpiler = new Bun.Transpiler({ loader: "ts" });

function transpileExample(source) {
  return transpiler.transformSync(source)
    .replace(/^\s*import\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, "")
    .replace(/^\s*import\s*['"][^'"]+['"];?/gm, "")
    .replace(/^\s*export\s+/gm, "");
}

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

function discover() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "meta.json") {
        const dirBase = p.slice(0, -"/meta.json".length);
        for (const demo of JSON.parse(readFileSync(p, "utf8")).demos) {
          const file = join(dirBase, demo.filename);
          if (!existsSync(file)) continue;
          const id = relative(REPO, file).replaceAll(sep, "/").replace(/\.ts$/, "");
          if (!FILTER || !id.includes(FILTER)) continue;
          out.push({ id, file });
        }
      }
    }
  };
  walk(REPO);
  return out;
}

// identical to compare-batch harnessHtml
function harnessHtml(source) {
  const g2umd = readFileSync(resolve(ROOT, "js/g2-browser-bundle.js"), "utf8")
    .replace(/<\/script>/gi, "<\\/script>");
  const js = SEEDED_RANDOM_PRELUDE + transpileExample(source).replace(/<\/script>/gi, "<\\/script>");
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<div id="errlog" style="position:fixed;top:0;left:0;z-index:9999;color:red;font:14px monospace;max-width:100%;white-space:pre-wrap"></div>
<div id="container" style="width:${WIDTH}px;height:${HEIGHT}px"></div>
<script>${g2umd}</script>
<script>
function L(m) { document.getElementById("errlog").textContent += m + "\\n"; }
window.onerror = function (m, s, l, c) { L("ERR: " + m + " @" + l + ":" + c); return true; };
window.onunhandledrejection = function (e) { L("REJECTION: " + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)); };
function walkSpec(value, visit, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((v) => walkSpec(v, visit, seen)); return; }
  visit(value);
  Object.values(value).forEach((v) => walkSpec(v, visit, seen));
}
let Chart;
try {
  Chart = class ProbeChart extends G2.Chart {
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
        const looks = "children" in node || "marks" in node || "encode" in node || ("type" in node && ("data" in node || "style" in node));
        if (!looks) return;
        if (node.animate !== false) { node.animate = false; changed += 1; }
        if (node.type === "timingKeyframe") { node.type = "view"; if (Array.isArray(node.children) && node.children.length > 1) { node.children = [node.children[0]]; } changed += 1; }
        if (node.interaction && Object.keys(node.interaction).length > 0) { node.interaction = {}; changed += 1; }
        if (node.tooltip) { node.tooltip = false; changed += 1; }
        if (node.slider) { node.slider = false; changed += 1; }
        if (node.scrollbar) { node.scrollbar = false; changed += 1; }
      });
      this.options(spec);
    }
    this.__rendered = true;
    return super.render(...args);
  }
  };
} catch (e) {
  L("SUBCLASS-FAIL: " + e.message + " — falling back to G2.Chart");
  Chart = G2.Chart;
}
(async function () {
  ${js}
  const c = globalThis.__lastChart;
  if (c && !c.__rendered && typeof c.render === "function") c.render();
  try {
    const cc = c && c.getContext && c.getContext().canvas.getConfig();
    document.getElementById("errlog").textContent += "SIZE=" + cc.width + "x" + cc.height + " inner=" + window.innerWidth + "x" + window.innerHeight + "\\n";
  } catch (e) {}
  document.getElementById("errlog").textContent += "HARNESS-OK chart=" + (c ? "yes" : "no") + "\\n";
  await new Promise((done) => {
    const poll = () => {
      const cv = document.querySelector("#container canvas");
      if (cv) setTimeout(done, 1200); else setTimeout(poll, 50);
    };
    poll();
  });
})();
</script></body></html>`;
}

async function main() {
  mkdirSync(ART, { recursive: true });
  const jobs = discover();
  if (jobs.length === 0) {
    console.log(`no example matches "${FILTER}"`);
    process.exit(1);
  }
  for (const job of jobs) {
    const htmlPath = resolve(ART, `_dbg.html`);
    const shotPath = resolve(ART, `${NAME}-chrome.png`);
    writeFileSync(htmlPath, harnessHtml(readFileSync(job.file, "utf8")));
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
    writeFileSync(transpiledPath, SEEDED_RANDOM_PRELUDE + transpileExample(readFileSync(job.file, "utf8")));
    execFileSync(G2_RS, ["--input", transpiledPath, "--name", NAME, "--output-dir", "artifacts/dbg"],
      { cwd: ROOT, timeout: 45_000, stdio: "pipe" });

    const a = PNG.sync.read(readFileSync(resolve(ART, `${NAME}-frame.png`)));
    const b = PNG.sync.read(readFileSync(shotPath));
    if (a.width !== b.width || a.height !== b.height) {
      console.log(`${job.id}: SIZE MISMATCH ${a.width}x${a.height} vs ${b.width}x${b.height}`);
      continue;
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
    const total = a.width * a.height;
    console.log(`${job.id}: diff>${THRESHOLD} ${((diffPixels / total) * 100).toFixed(2)}% meanDelta=${(sumDelta / total).toFixed(2)} avg_p8=${((sumDelta / total / 255) * 100).toFixed(2)}%`);
    console.log(`  artifacts/dbg/${NAME}-{frame,chrome,diff}.png  logs: artifacts/dbg/${NAME}-logs.txt`);
  }
}

main();
