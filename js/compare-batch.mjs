// Batch: run every G2 gallery example through Edge (truth) and g2-rs, pixel-diff.
// Usage: bun compare-batch.mjs [filter-substring]   e.g. bun compare-batch.mjs general/
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve, join, relative, sep } from "node:path";
import { PNG } from "pngjs";

const execFileP = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const REPO = resolve(ROOT, ".g2-repo/site/examples");
const ART = resolve(ROOT, "artifacts/batch");
const OUT = resolve(ART, "results.jsonl");
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
const CONCURRENCY = 3;
const TIMEOUT_MS = 45_000;
const VIRTUAL_TIME_BUDGET = 30_000;
const FILTER = process.argv[2] || "";

const g2umd = readFileSync(resolve(ROOT, "js/node_modules/@antv/g2/dist/g2.min.js"), "utf8")
  .replace(/<\/script>/gi, "<\\/script>");
const transpiler = new Bun.Transpiler({ loader: "ts" });

// TS -> JS plus import/export stripping; the exact source both sides execute.
function transpileExample(source) {
  return transpiler.transformSync(source)
    .replace(/^\s*import\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, "")
    .replace(/^\s*import\s*['"][^'"]+['"];?/gm, "")
    .replace(/^\s*export\s+/gm, "");
}

// Deterministic Math.random so both sides generate identical "random" data.
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
  for (const metaPath of discoverFiles(REPO, "meta.json")) {
    const dir = metaPath.slice(0, -"/meta.json".length);
    const category = relative(REPO, dir).split(sep)[0];
    for (const demo of JSON.parse(readFileSync(metaPath, "utf8")).demos) {
      const file = join(dir, demo.filename);
      if (!existsSync(file)) continue;
      const id = relative(REPO, file).replaceAll(sep, "/").replace(/\.ts$/, "");
      if (FILTER && !id.includes(FILTER)) continue;
      out.push({ id, file });
    }
  }
  return out;
}

function discoverFiles(dir, name, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) discoverFiles(p, name, acc);
    else if (entry.name === name) acc.push(p);
  }
  return acc;
}

function harnessHtml(source) {
  const js = transpileExample(source).replace(/<\/script>/gi, "<\\/script>");
  // Same static-mode normalization as our g2-probe: animations/interactions off so
  // both sides render one deterministic final frame.
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
        // Only marks/views take animate; polluting transform nodes (type:groupX)
        // leaks animate:false into aggregate options -> "Unknown reducer: false".
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

async function runEdge(htmlPath, shotPath, profileDir) {
  await execFileP(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${shotPath}`,
      `--virtual-time-budget=${VIRTUAL_TIME_BUDGET}`,
      pathToFileURL(htmlPath).href,
    ], { timeout: TIMEOUT_MS, stdio: "ignore" });
}

async function runG2rs(examplePath, name) {
  await execFileP(G2_RS, [
    "--input", examplePath, "--name", name, "--output-dir", "artifacts/batch",
  ], { cwd: ROOT, timeout: TIMEOUT_MS, stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
}

function pixelDiff(aPath, bPath) {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) return { error: "size-mismatch" };
  let diffPixels = 0, sumDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    sumDelta += d;
    if (d > THRESHOLD) diffPixels += 1;
  }
  const total = a.width * a.height;
  return { diffPct: +((diffPixels / total) * 100).toFixed(2), meanDelta: +(sumDelta / total).toFixed(2) };
}

async function checkOne(job, slot) {
  const name = job.id.replaceAll("/", "-");
  const htmlPath = resolve(ART, `_${slot}.html`);
  const shotPath = resolve(ART, `${name}-chrome.png`);
  // Same transpiled source on both sides: Bun TS->JS for the browser harness AND g2-rs.
  const transpiledPath = resolve(ART, `_${slot}-transpiled.js`);
  const rec = { id: job.id };
  try {
    const js = SEEDED_RANDOM_PRELUDE + transpileExample(readFileSync(job.file, "utf8"));
    writeFileSync(htmlPath, harnessHtml(js));
    writeFileSync(transpiledPath, js);
    await runEdge(htmlPath, shotPath, resolve(ART, `edge-profile-${slot}`));
    await runG2rs(transpiledPath, name);
    rec.result = pixelDiff(resolve(ART, `${name}-frame.png`), shotPath);
    //中间产物只留排查所需:diff 达标的直接删 commands/logs
    if (rec.result && !rec.result.error && rec.result.meanDelta / 255 * 100 < 2) {
      for (const suffix of ["-commands.json", "-logs.txt", "-frame.png"]) {
        rmSync(resolve(ART, `${name}${suffix}`), { force: true });
      }
    }
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    rec.error = String(error.message || error).slice(0, 200) + (stderr ? " | " + stderr.slice(0, 300) : "");
  }
  return rec;
}

async function main() {
  mkdirSync(ART, { recursive: true });
  const jobs = discover();
  console.log(`[batch] ${jobs.length} examples, concurrency=${CONCURRENCY}`);
  const results = [];
  let done = 0;
  const queue = jobs.map((j, i) => ({ j, slot: i % CONCURRENCY }));
  const workers = Array.from({ length: CONCURRENCY }, async (_, slot) => {
    const mine = queue.filter((q) => q.slot === slot).map((q) => q.j);
    for (const job of mine) {
      const rec = await checkOne(job, slot);
      results.push(rec);
      done += 1;
      if (done % 20 === 0 || done === jobs.length) console.log(`[batch] ${done}/${jobs.length}`);
      writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n"));
    }
  });
  await Promise.all(workers);

  const ok = results.filter((r) => r.result && !r.result.error);
  const fail = results.filter((r) => r.error);
  const sizeMismatch = results.filter((r) => r.result?.error);
  const bucket = (lo, hi) => ok.filter((r) => r.result.diffPct >= lo && r.result.diffPct < hi).length;
  console.log(`
=== SUMMARY (${ok.length} diffed, ${fail.length} crashed, ${sizeMismatch.length} size-mismatch) ===`);
  console.log(`  <3%   : ${bucket(0, 3)}`);
  console.log(`  3-10% : ${bucket(3, 10)}`);
  console.log(`  10-30%: ${bucket(10, 30)}`);
  console.log(`  >30%  : ${bucket(30, 101)}`);
  const worst = [...ok].sort((a, b) => b.result.diffPct - a.result.diffPct).slice(0, 25);
  console.log("\nWORST:");
  for (const r of worst) console.log(`  ${r.result.diffPct}%\t${r.id}`);
  if (fail.length) {
    console.log("\nCRASHED (first 15):");
    for (const r of fail.slice(0, 15)) console.log(`  ${r.id}\t${r.error}`);
  }
}

main();
