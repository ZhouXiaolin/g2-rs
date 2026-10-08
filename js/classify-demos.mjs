// Classify gallery demos: animate-class vs scene-class vs view-class (rest).
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const REPO = ".g2-repo/site/examples";
const norm = (s) =>
  s
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replaceAll("\\", "/"))
    .map((p) => {
      const idx = p.indexOf("site/examples/");
      return idx >= 0 ? p.slice(idx + "site/examples/".length) : p.replace(/^\.\//, "");
    })
    .map((p) => p.replace(/\.ts$/, ""))
    .sort();

const animA = norm(execSync(`grep -rlE "animate:\\s*\\{" --include="*.ts" ${REPO}`).toString());
const animB = norm(execSync(`grep -rl "timingKeyframe" --include="*.ts" ${REPO}`).toString());
const scene = norm(execSync(`find ${REPO}/scene -name "*.ts"`).toString());
const anim = [...new Set([...animA, ...animB])].filter((id) => !id.startsWith("scene/"));

writeFileSync("artifacts/anim-class.txt", anim.join("\n"));
writeFileSync("artifacts/scene-class.txt", scene.join("\n"));
console.log("animate-class:", anim.length, " scene-class:", scene.length);
