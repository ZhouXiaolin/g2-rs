# g2-rs

用 Rust 复刻 [AntV G2](https://github.com/antvis/G2) 的 CanvasKit 渲染管线，并对其做像素级对齐核对：

- **QuickJS**（[rquickjs](https://github.com/DelSkayn/rquickjs)）运行 G2 官方 bundle；
- **fake CanvasKit** 不加载真正的 CanvasKit wasm，而是把 `@antv/g-canvaskit` 的每一条绘制调用（路径、渐变、文本、图片……）捕获成 JSON 命令流；
- **skia-safe** 按相同语义把命令流重放成 PNG；
- 以 **Edge headless 截图为真值**，逐像素 diff，把"像不像"变成一个可持续回归的工程指标。

## 对齐方法

两侧唯一的差异应当来自渲染器本身，因此两侧执行的是**完全相同的确定性输入**：

1. **同一份源码**。`.g2-repo` 里的 TS demo 经同一套转译流程（`Bun.Transpiler` 的 ts loader + import/export 剥离正则）得到同一份 JS；Edge 页面和 g2-rs 进程拿到的源码逐字节相同（见 `js/compare-batch.mjs` 的 `transpileExample`）。
2. **确定性随机**。转译产物前注入 seed=42 的 `Math.random` 替身（mulberry32），两侧数据相同。
3. **静态化归一**。两侧都以相同规则关掉动画与交互（`animate: false`、`interaction: {}`、`timingKeyframe` 降级为普通 view、去掉 tooltip/slider/scrollbar），只渲染最终一帧。
4. **虚拟时钟**。Edge 用 `--virtual-time-budget=30000` 快进定时器；g2-rs 的 QuickJS 宿主同步驱动 rAF 队列，帧推进语义一致。
5. **命令级重放**。g2-rs 不跑 CanvasKit wasm，而是捕获命令后用 skia-safe 重放。文本度量走 DirectWrite 并对齐 Chrome 的行为：subpixel + 无 hint 的步进宽度、四项 bounding-box 指标整数量化、`fontBoundingBox` 取 win metrics 而非 typo metrics。
6. **像素 diff**。960x540 RGBA 逐像素取 RGB 三通道最大差值：`avg_p8 = meanDelta / 255 * 100`，验收门槛 **< 2%**；另有阈值 16 的差异像素占比作参考。

## 目录结构

```
src/            Rust 源码
  g2.rs           QuickJS 宿主：日志、fetch、文本度量、图片解码等原生桥
  g2_canvas.rs    命令流 -> skia-safe 重放
  main.rs         CLI
js/
  compare-batch.mjs   批量核对脚本（唯一核对入口）
  g2-probe.mjs        G2 探针：加载 demo、静态化归一、收集命令与日志
  fake-g-canvaskit.mjs + shims/ + patch-bundle.mjs
                      bundle 构建链（esbuild 打成 g2-bundle.js，patch 补图案填充分支）
  g2-bundle.js        构建产物，exe 运行时加载（仓库自带现成一份）
  package.json        js 依赖与 bundle 构建脚本
examples/       5 个取自 g2-repo 官方示例库的样例（已转译为两侧一致的 JS）
.g2-repo/       antvis/G2 的本地 clone（不入库）
artifacts/      各类输出（不入库）
```

## 环境要求

- Windows：文本度量对齐的是 Chrome/Edge 在 Windows 上的 DirectWrite 行为；
- Rust toolchain（edition 2021）；
- [bun](https://bun.sh)：安装 js 依赖、构建 bundle、运行 compare-batch；
- Microsoft Edge：真值截图，路径写死在 `js/compare-batch.mjs` 顶部，可自行修改。

## 构建

```bash
git clone https://github.com/antvis/G2 .g2-repo   # 官方示例库，核对对象
cd js && bun install && bun run build:g2 && cd .. # 生成 js/g2-bundle.js
cargo build --release                             # 生成 target/release/g2-rs.exe
```

## 运行单个示例

```bash
./target/release/g2-rs.exe --input examples/column-maxwidth.js
# 从 stdin 读入：
Get-Content examples/column-maxwidth.js | ./target/release/g2-rs.exe --input -
```

输出写入 `--output-dir`（默认 `artifacts/`）：

| 文件 | 内容 |
| --- | --- |
| `<name>-commands.json` | fake CanvasKit 捕获的绘制命令流 |
| `<name>-frame.png` | skia-safe 重放出的渲染结果 |
| `<name>-logs.txt` | 探针与 G2 的运行日志 |

参数：`--input`（必填，`-` 为 stdin）、`--output-dir`、`--width`/`--height`（默认 960x540）、`--container-id`、`--name`（输出文件名前缀）。

## 批量核对：compare-batch（唯一核对点）

```bash
bun js/compare-batch.mjs [过滤子串]     # 例：bun js/compare-batch.mjs general/
```

对 `.g2-repo/site/examples` 下每个 demo：转译 → Edge 截图（真值）与 g2-rs 重放执行**同一份 JS** → 逐像素 diff。结果逐行追加到 `artifacts/batch/results.jsonl`，并在结束时打印最差名单；达标的中间产物自动清理，未达标的保留 `-frame.png`/`-commands.json`/`-logs.txt` 供排查。

当前基线（skia-safe 0.153 / ureq 3 / rquickjs 0.14）：423 个可 diff 的 demo，0 崩溃，333 个 < 2%，361 个 < 3%，均值 1.92%。已知剩余差距集中在 `scene/*` 复杂场景图、wordCloud、图案填充、boxplot 等类别。

## examples/ 说明

5 个示例均来自官方示例库 `site/examples/`，经与 compare-batch 完全相同的转译流程生成，即两侧实际执行的那份源码；括号内为实测 avg_p8：

| 文件 | 来源 |
| --- | --- |
| `area-mini.js` | `general/mini/demo/area.ts`（0.07%） |
| `column-maxwidth.js` | `general/interval/demo/column-maxwidth.ts`（0.29%） |
| `point-style.js` | `general/point/demo/point-style.ts`（0.29%） |
| `axis-polar.js` | `component/axis/demo/axis-polar.ts`（0.19%） |
| `facet-circle.js` | `composition/facet/demo/circle.ts`（0.38%） |
