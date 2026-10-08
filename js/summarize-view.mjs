// Summarize batch results by class (view/animate/scene) against the avg_p8 gate.
// Usage: bun js/summarize-view.mjs [results.jsonl]
import { readFileSync } from "node:fs";

const file = process.argv[2] || "artifacts/batch/results.jsonl";
const anim = new Set(readFileSync("artifacts/anim-class.txt", "utf8").trim().split("\n"));
const scene = new Set(readFileSync("artifacts/scene-class.txt", "utf8").trim().split("\n"));

const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cls = (id) => (scene.has(id) ? "scene" : anim.has(id) ? "animate" : "view");

const avgP8 = (r) => (r.result.meanDelta / 255) * 100;

const stat = { view: { ok: 0, pass: 0, fail: [], crash: 0 }, animate: { ok: 0, pass: 0, fail: [], crash: 0 }, scene: { ok: 0, pass: 0, fail: [], crash: 0 } };
for (const r of lines) {
  const c = stat[cls(r.id)];
  if (r.error) {
    c.crash += 1;
    continue;
  }
  if (!r.result || r.result.error) continue;
  c.ok += 1;
  if (avgP8(r) < 2) c.pass += 1;
  else c.fail.push({ id: r.id, p8: avgP8(r), diff: r.result.diffPct });
}

for (const name of ["view", "animate", "scene"]) {
  const c = stat[name];
  console.log(`\n=== ${name}: ${c.ok} diffed, ${c.pass} pass (<2%), ${c.fail.length} fail, ${c.crash} crash ===`);
  for (const f of c.fail.sort((a, b) => b.p8 - a.p8).slice(0, 40)) {
    console.log(`  ${f.p8.toFixed(2)}%  diff=${String(f.diff).padStart(6)}%  ${f.id}`);
  }
}
