# render-audit · 渲染错位诊断（开发/验收辅助，不参与运行时）

这是「拾光游戏厅」渲染问题的**可复跑诊断脚本**，用于区分两类现象：

1. **审计基线的非整数显示缩放**：当时 client 默认 `fit` 模式把 256×240 的画布放进 4:3 盒子（横向 ≈1.25× 拉伸），
   且 CSS 尺寸/DPR 往往是非整数倍；最近邻放大时源像素列会变成 3/4 设备像素交替（行高 2/3 交替）。
2. **帧缓冲真实错位**：jsnes `/engine` 输出的原始 256×240 帧里是否存在 8px tile/精灵层间偏移。

## 依赖（只为测试，不进插件运行时依赖）

- Node 24（DSH 运行时自带），Python 3 + Pillow（DSH 运行时自带）
- Google Chrome（headless 截图用；macOS 默认 `/Applications/Google Chrome.app/...`，可用 `CHROME_PATH` 覆盖）
- **SEN**（独立实现的高精度 NES 模拟器，作为对照 oracle，仅测试用）：
  ```sh
  cd dsh-game-bench/selftest/render-audit
  <node> <pnpm> add @lukad/sen@0.7.0     # 或设置 RENDER_AUDIT_SEN_DIR 指向已安装的包根目录
  ```
  - `@lukad/sen` 0.7.0 · license **MIT** · <https://github.com/lukad/sen> ·
    npm integrity `sha512-5oRVkkDJYJXXgQqpg3IlrizAIu4dYzUszB91d3efh/tBTN5BCkVVSvNPquZiDD7Ppq8H8LlH2dHlIjUYh+i/iQ==`
  - 仅用于对照测试；**不得**出现在 `package.json` 依赖或发布产物中。
- jsnes 2.1.0（Apache-2.0）：直接使用插件自带的 `vendor/jsnes.min.js`（与 npm dist 字节一致）。

脚本只**读取** `games/*.nes`（用户 ROM 保持只读），不修改任何生产文件；输出写到本目录 `out/`（已 gitignore）。

## 复跑

```sh
N=<node>            # 如 /Users/xxx/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
P=<python3>         # 带 Pillow 的 python

$N capture-pure.mjs      # 8 款 ROM：纯 jsnes 原生 256x240 帧 -> out/pure
$N capture-sen.mjs       # SEN 对照帧 -> out/sen（需要 @lukad/sen）
$N capture-engine.mjs    # 生产 engine.js + vendor jsnes（假 canvas）逐帧截 putImageData -> out/engine
$N structural.mjs        # 跨模拟器结构对齐（调色板无关）-> out/structural-compare.json
$N dense-jackal.mjs      # Jackal 密集采样：±8px 位移搜索 -> out/dense-jackal.json
$N layers.mjs            # 精灵层/背景层分离 + OAM 区间校验 -> out/layers
$N browser-raster.mjs    # 真实 Chrome 按 client CSS 尺寸/DPR 截图 -> out/browser
$P raster-analyze.py     # 分析 Chrome 截图的列宽/行高/平滑 -> out/browser/raster-report.json
$P raw2png.py pure --sheet   # 原生帧转 PNG（目视）
$P display-demo.py       # fit vs pixel 缩放量化 + 最近邻模拟图 -> out/display
$N compare.mjs            # 逐字节比较（受两边调色板差异影响，仅参考）
```

关键结果快照见 `results/`（JSON + 不含游戏画面的合成测试图案截图）。

## 结果摘要（2026-11-09 本机实测）

- engine 写进 canvas 的字节 = 纯 jsnes 帧缓冲（8 款 ×1000 帧，±4 帧窗口内 99.8%~100% 完全一致；canvas 256×240，
  `putImageData` 原点 (0,0)，零重采样）。
- 帧缓冲层：在**能建立跨模拟器帧对应**的样本里（Jackal 30–150 帧等），边缘图 IoU@(0,0)≈0.979，
  ±8px 搜索未出现更优位移；精灵层像素 0 个落在 OAM `[sprX, sprX+7]` 区间之外（`layers.mjs`）。
  **注意：SEN 与 jsnes 的 CPU/PPU 时序模型不同，长跑后帧号不再对应（dense 40 帧里仅 5 帧可比），
  因此该结论只覆盖“已对齐的采样帧”，不能外推为所有场景。**
- 显示层：`fit` 模式 933×700（DPR1）实测源像素列宽 **3/4 交替**（91 列 3px、165 列 4px），行高 **2/3 交替**；
  DPR2 时 7/8、5/6；`image-rendering:pixelated` 与 `crisp-edges` 输出相同，`auto` 会平滑（灰像素 701/行）。
  8px tile 边界相对理想位置漂移 ≤0.5 设备像素（不会产生 8px 错位，但像素宽度不均匀 + 横向 1.25× 拉伸）。
- jsnes 上游：npm 2.1.0 的 `src/**` 与 `bfirsh/jsnes` main 分支**逐文件 SHA 相同**，无更新版本可升级；
  上游 Jackal 相关 issue（#44/#316）是 1.x 时代“跑不起来/灰屏”，与本症状不同。

详细证据报告：`../../docs/rendering-audit.md`。
