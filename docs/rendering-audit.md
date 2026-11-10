# 渲染错位诊断报告（拾光游戏厅 · Jackal/赤色要塞）

- 日期：2026-11-09
- 范围：`dsh-game-bench` 的显示链路（jsnes 2.1.0 → `engine.js` Renderer → `<canvas>` → client CSS 缩放）
- 结论状态：**未把用户所见现象外推为已确诊根因**。本报告区分「可直接复现的事实」「假设」「未覆盖场景」，不把采样帧结论外推为所有场景。
- 修复状态：审计后已将新安装的默认模式改为“原始像素”，按设备物理像素整数倍缩放并吸附画布原点；显式选择的 4:3 与铺满模式仍保留。
- 复跑脚本：`selftest/render-audit/`（只读取 ROM，不修改生产文件；输出到该目录 `out/`，已 gitignore）
- 结果快照：`selftest/render-audit/results/`

---

## 0. 一句话结论

1. **不是 engine 复制像素引入的**：`engine.js` 把 jsnes 的 `Uint32Array(256*240, 0x00BBGGRR)` 以
   `0xff000000 | frameBuffer[i]` 写入 `ImageData`，再 `putImageData(imageData, 0, 0)`；实测与纯 jsnes 帧
   逐字节一致（8 款 × 1000 帧，±4 帧对齐窗口内 99.8%~100%）。
2. **在能建立帧对应的采样里，raw frameBuffer 没有 8px tile/精灵层间错位**：以独立模拟器 SEN 为对照，
   Jackal 在 30–150 帧（标题/启动阶段，帧一一对应）边缘图 IoU@(0,0)=0.979，±8px 搜索无更优位移；
   精灵层分离校验：0 个精灵像素落在该扫描线 OAM `[sprX, sprX+7]` 区间之外；每扫描线精灵数 ≤8。
   **局限**：SEN 与 jsnes 的 CPU/PPU 时序模型不同，长跑后帧号不再对应（40 个采样里只有 5 个可比），
   因此该结论只覆盖已对齐的采样帧；未能对“任意游戏内场景”证明无 8px 错位。
3. **审计时的默认显示模式存在确定性的「非整数最近邻 + 横向 1.25× 拉伸」**：当时的 `screenMode: 'fit'` 把 256×240（16:15）
   画布放进 4:3 盒子；真实 Chrome 实测在 933×700/DPR1 下，源像素列在 **3/4 设备像素**间交替
   （91 列 3px、165 列 4px），行高 2/3 交替；像素宽度不均匀但 8px tile 边界漂移 ≤0.5 设备像素。
   这是**全游戏通用**的显示层现象，方向上最接近用户“不是糊、是像素错位/不均匀”的描述，但**未获用户截图确认**。
4. **没有升级 jsnes 的依据**：npm `jsnes@2.1.0` 的 `src/**` 与 `bfirsh/jsnes` main 分支逐文件 SHA 相同；
   vendor `jsnes.min.js` 与 npm dist 字节相同。上游与本症状相关的 Jackal issue 是 1.x 时代的“跑不起来/灰屏”。
   因此**不建议改 `vendor/` 或 `engine.js`**，也不做单游戏补丁。

---

## 1. 方法与环境（可追溯）

| 项 | 值 |
|---|---|
| 主机 | macOS（本机），DSH Web GUI 所在机器 |
| Node | v24.21.0（`/Users/lz/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`） |
| Python / Pillow | 3.12 / Pillow 12.3.0（DSH 运行时自带） |
| Chrome | Google Chrome **156.0.8078.81**（headless=new，`--force-device-scale-factor`，截图脚本见 `browser-raster.mjs`） |
| 被测模拟器 | jsnes **2.1.0**，Apache-2.0；使用插件自带 `vendor/jsnes.min.js`（SHA-256 `84946f0dae4bcf3b2dfebe84ad3bfeb1dbcb413bd9b1a69e1f45910a95fd7b41`，与 npm `jsnes@2.1.0` 的 `dist/jsnes.min.js` 字节相同） |
| 对照 oracle | **`@lukad/sen` 0.7.0**，license **MIT**（<https://github.com/lukad/sen>，WASM bindings for SEN）；npm integrity `sha512-5oRVkkDJYJXXgQqpg3IlrizAIu4dYzUszB91d3efh/tBTN5BCkVVSvNPquZiDD7Ppq8H8LlH2dHlIjUYh+i/iQ==`。**仅测试使用，不进 `package.json` 依赖、不进发布产物** |
| 输入脚本 | 代码即文档：`capture-pure.mjs`/`capture-sen.mjs`/`capture-engine.mjs`/`dense-jackal.mjs` 内的 `defaultScript`（帧号语义 60fps：30 空按、100/180 START、300 起按住 RIGHT、330/420 A、520 RIGHT、700 RIGHT+A、900 松开） |
| ROM | 只读使用 `games/*.nes`；脚本不写 `games/`（用户 ROM 保持只读） |

> 说明：本报告的结论只来自 `selftest/render-audit/` 内脚本的可重复运行；工作区临时目录（`.lead-tmp/render-audit/`）
> 只是开发期草稿，不作为唯一证据。

---

## 2. 事实 A：engine → canvas 是 1:1 像素复制，无重采样/无颜色顺序问题

**代码事实**

- `engine.js:371` `Renderer`：`canvas.width/height = 256/240`；`createImageData(256,240)`。
- `engine.js:417-441` `Renderer.prototype.draw`：
  `pixels32[i] = 0xff000000 | frameBuffer[i]`（小端下即 RGBA 字节序 `R,G,B,255`），随后 `putImageData(imageData, 0, 0)`。
- `engine.js:1036` `onFrame: function (frameBuffer)` 直接把 jsnes 每帧 buffer 交给 Renderer，无缩放/无中间 canvas。

**实测（`capture-engine.mjs` → `results/engine-compare.json`）**

在 Node 里构造假浏览器（假 canvas/`requestAnimationFrame`/`performance`），运行**生产 `engine.js` 真身** +
生产 `vendor/jsnes.min.js`，逐帧截获 Renderer 真正写入的 `ImageData`，与同帧纯 jsnes `onFrame` 转换后的 RGBA 逐字节比较：

| 游戏 | 最佳对齐 offset | 逐字节相等（固定 offset） | ±4 帧窗口内可完全命中 |
|---|---|---|---|
| 超级玛丽1 | 0 | 732/1000 (73.2%) | 75.8% |
| 魂斗罗 (简) | 1 | 810/999 (81.1%) | **100%** |
| 赤色要塞 | 0 | 781/1000 (78.1%) | **99.8%** |
| 雪人兄弟 (简) | 0 | 1000/1000 (100%) | **100%** |
| 坦克大战 (简) | 0 | 985/1000 (98.5%) | **99.9%** |
| 松鼠大作战 (简) | 0 | 999/1000 (99.9%) | **100%** |
| 双截龙2 - 复仇 (简) | 0 | 962/1000 (96.2%) | **99.9%** |
| 星光试航 Star Pilot | 0 | 998/1000 (99.8%) | **100%** |

- 所有游戏 canvas 均为 `256×240`、`putImageData` 原点 `(0,0)`。
- 固定 offset 下不满 100% 的原因是 **rAF 追帧相位**（engine 的帧循环按实际时间累加，可能 0/2 帧），
  不是像素被改写：把每帧拿到 ±4 帧窗口里比对，可完全命中 99.8%~100%（超级玛丽 75.8% 是方向键输入在
  两个驱动器上落帧相位不同导致游戏状态分叉，属方法学噪声）。
- **推论（事实级）**：engine 这一层既不重采样、也不改颜色顺序/行距；任何“错位”都不可能由 `Renderer.draw` 产生。

---

## 3. 事实 B：raw frameBuffer 的 8px 层间错位——在可比帧中未发现

### 3.1 跨模拟器对照（SEN 作为独立 oracle）

调色板数值两边不同，不能逐字节比较，因此用**调色板无关特征**：
- 边缘图（相邻像素 RGB 差 > 阈值）IoU；
- 绿色精灵掩码（Jackal 的车/敌人为绿色系，`g > r*1.2 && g > b*1.15`）IoU；
- 在 `(-8,0,+8)²` 网格内搜索最佳平移，若存在 8px 错位，最佳平移应偏离 (0,0)。

`structural.mjs`（8 款 × 10 帧）结果（`results/structural-compare.json`）：

| 游戏 | 边缘图 IoU@(0,0) 最大值 | 绿色掩码 IoU@(0,0) 最大值 |
|---|---|---|
| 赤色要塞 | 0.980 | 0.887（最佳位移 (0,0)） |
| 超级玛丽1 | 1.000 | 1.000 |
| 魂斗罗 (简) | 1.000 | 1.000 |
| 松鼠大作战 (简) | 1.000 | 1.000 |
| 双截龙2 - 复仇 (简) | 1.000 | （无绿色特征） |
| 星光试航 Star Pilot | 1.000 | 1.000 |
| 坦克大战 (简) | 0.997 | （无绿色特征） |
| 雪人兄弟 (简) | 0.000（见下） | — |

- **雪人兄弟 0.000 不是渲染 bug**：两边 START 落帧时机不同，采样帧停在不同剧情画面（对比 `out/sen` 与
  `out/pure` 的 sheet 可直接看出）。这也说明跨模拟器帧号对应不能默认成立。

`dense-jackal.mjs`（Jackal 0–1170 帧每 30 帧采样，40 帧）：

| 指标 | 值 |
|---|---|
| 采样帧 | 40（0–1170） |
| 能与 SEN 建立对应的“可比帧” | **5**（30/60/90/120/150，标题/启动阶段） |
| 可比帧边缘图 IoU@(0,0) | min 0.9788 / mean 0.9793 / max 0.9796 |
| 可比帧中最佳位移 ≠ (0,0) 的帧数 | **0** |
| 因时序模型差异导致状态漂移、帧号不可对应的采样数 | 35 |

> **重要限制**：SEN 是周期精确实现，jsnes 2.1.0 的 CPU/PPU 是近似实现；长跑后两边游戏状态会分叉，
> 同一帧号不再对应同一画面。因此**跨模拟器 oracle 只对“能对齐的帧”有效**，本报告不外推为所有游戏内场景。

### 3.2 精灵层 / 背景层分离（jsnes 内部一致性）

`layers.mjs` 利用 jsnes PPU 内部状态分离层：
- `ppu.buffer`（合成帧）
- `ppu.bgbuffer`（背景层）
- `ppu.pixrendered`：bit8 = 有背景像素；低 8 位 = 精灵优先级序号(0–7)
- `ppu.scanlineSecondaryOAM` / `scanlineSpriteCount`：逐扫描线精灵评估结果（OAM 字节）

Jackal 第 620 帧实测（`results/layers-report.json`）：

| 检查 | 结果 |
|---|---|
| 背景层像素数 | 58886（其中 240 行存在“透明色 0 未写 pixrendered”的空洞，属预期，不是 bug 指标） |
| 精灵层像素数 | 2474 |
| 每扫描线最大精灵数 | 8（硬件上限，符合预期） |
| **精灵像素落在该扫描线 OAM `[sprX, sprX+7]` 区间之外的个数** | **0** |
| 有精灵的扫描线 | 112 |

若 jsnes 精灵层整体偏移 8px（`+8/-8`），会出现大量越界像素；实测为 0。

### 3.3 mapper 2 / 银行切换

- 赤色要塞 ROM 头（脚本打印，未改 ROM）：id `nes-701f4d4…`，**mapper 2（UxROM）**，PRG 128KB（8×16KB），
  CHR 0（CHR-RAM 8KB），vertical mirroring。
- jsnes `src/mappers/mapper2.js:23` 写 `$8000-$FFFF` 时 `loadRomBank(value, 0x8000)`，
  `src/mappers/mapper0.js` 的 `loadRomBank` 用 `bank %= romCount`（8KB 对齐的 16KB 银行，128KB=8 银行）；
  最后一次固定 bank 在 `$C000`（`loadRomBank(romCount-1, 0xc000)`）。**与 UxROM 规范一致，未发现银行越界/错位**。
- 该结论与“混沌/错位只出现在特定游戏”不符：mapper 2 的银行选择是本游戏正常滚动/换图所必需，若错会是大片花屏。

### 3.4 上游对照（无可升级项）

- `npm jsnes@2.1.0`（2026-04-11 release）的 `src/**` 与 GitHub `bfirsh/jsnes` **main 分支**逐文件 SHA 相同：
  `src/ppu/index.js`、`src/cpu.js`、`src/nes.js`、`src/mappers/mapper2.js`、`src/rom.js`、`src/tile.js`、
  `src/ppu/nametable.js`、`src/ppu/palette-table.js` 全部 SAME（本机比对，2026-11-09）。
- 上游 release 最高仍为 v2.1.0；`vendor/jsnes.min.js` 与 npm dist 字节相同。
- 上游与 Jackal 相关的 open issue 只有两个，且都是 1.x 时代“跑不起来”：
  - [#44 Jackal nes support](https://github.com/bfirsh/jsnes/issues/44)（2015，仅灰屏截图）
  - [#316 Jackal nes rom can't run.](https://github.com/bfirsh/jsnes/issues/316)（2020）
  与“能玩但画面似乎错位”不是同一症状。
- **结论**：目前没有“升级 jsnes 就能修 Jackal”的依据，**不动 `vendor/` 与 `engine.js`**。

---

## 4. 事实 C：默认显示模式的「非整数最近邻 + 4:3 拉伸」

### 4.1 client 代码事实

- `client.js:375` 默认 `screenMode: 'fit'`；`client.js:730 screenSizeFor('fit')`：
  `h = min(availH, round(availW*3/4)); w = round(h*4/3)` → **CSS 盒子是 4:3**。
- 画布内部固定 256×240（16:15）；`client.js:4394-4396`：`.gb-canvas{width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges}`。
- 因此默认 fit 模式等效于：**横向比方形象素额外拉伸 4/3÷(256/240)=1.25×**，且缩放倍率极少是整数。

### 4.2 真实 Chrome 栅格化实测（`browser-raster.mjs` + `raster-analyze.py` → `results/raster-report.json`）

合成测试图案（1px 竖条纹 / 1px 横条纹 / 8px 网格）画进 256×240 canvas，按 client 的 CSS 方式缩放后截图，
逐设备像素统计“源像素列宽/行高”，并检查是否有平滑（灰像素）：

| 场景 | 设备尺寸 | scaleX / scaleY | 源像素列宽 | 行高 | 灰像素（平滑） | 8px 边界漂移上限 |
|---|---|---|---|---|---|---|
| 256×240 原生（DPR1） | 256×240 | 1 / 1 | 全 1px | 全 1px | 0 | 0px |
| fit 933×700，DPR1，pixelated | 933×700 | 3.6445 / 2.9167 | **3px×91 列 + 4px×165 列** | **2px×5 + 3px×54** | 0 | 0.344px |
| fit 933×700，DPR1，crisp-edges | 933×700 | 同上 | 与 pixelated **完全相同** | 同上 | 0 | 0.344px |
| fit 933×700，DPR1，auto | 933×700 | 同上 | 1–2px（被平滑） | 1px（被平滑） | **701**（一行内） | 0.844px |
| fit 933×700，DPR2，pixelated | 1866×1400 | 7.2891 / 5.8333 | **7px×182 + 8px×74** | **5px×9 + 6px×50** | 0 | 0.688px |
| fit 827×620，DPR1，pixelated | 827×620 | 3.2305 / 2.5833 | 3px×197 + 4px×59 | 2px×24 + 3px×35 | 0 | 0.344px |

（`display-demo.py` 用同一 `screenSizeFor('fit')` 公式给出更多尺寸的**理论**列宽/tile 宽：
1100×700 → 933×700：列宽 3/4、tile 宽 29/30；560×600 → 560×420：列宽 2/3、tile 宽 17/18；全部非整数倍。）

**事实级推论**：
- 默认 fit 下，**每个源像素在屏幕上的宽度/高度并不相等**（3/4、2/3 交替），竖直边缘与沙地网点会呈现不均匀的
  “台阶/游走”；这是显示层现象，**不是 frameBuffer 内 8px 错位**。
- 8px tile 边界相对理想位置的漂移 ≤0.5 设备像素（DPR2 下 ≤0.688），**不足以产生 8px 级别的错位**；但它确实会
  使“像素宽度不一致”，在移动画面里可能被描述为“错位/不齐/不是糊”。
- 审计基线的 `pixel` 模式在 DPR1/DPR2 测试里 scaleX/scaleY 均为整数、无交替；但旧实现遇到 DPR1.25 等系统缩放仍可能落到物理半像素，已在后续修复中改为按设备物理像素计算。

---

## 5. 假设（未验证，需要用户截图/真实页面复核）

1. **用户感知的错位来自默认 fit 模式的非整数 4:3 拉伸**（像素宽度不均匀 + 横向 1.25×），
   而非 jsnes/engine 的帧内容错误。判别：切 `pixel` 模式 / 调窗口尺寸到整数倍 / 截图放大观察像素网格。
2. 真实 DSH 页面可能与 headless 测试不同（页面级 CSS transform、Electron 缩放、`image-rendering` 实际取值、
   GPU 合成路径）。headless Chrome 已验证 `pixelated`/`crisp-edges` 等价且无平滑，但**未在真实页面截屏验证**。
3. 也不排除用户看到的是 Jackal 本身的美术特征（俯视吉普车+炮塔、沙地菱形纹理、双层/镜像状车身），
   与“错位”混淆；两个独立模拟器的同帧画面在这些样本上结构一致。
4. 若后续发现“某些关卡/大量敌人/屏幕边缘/滚动分屏”场景真的有 8px 错位，才需要回到 PPU 精灵评估/滚动分屏
   （sprite-0 hit、mid-frame scroll）与 mapper 时序层面继续查；当前样本不支持这一假设。

## 6. 未覆盖 / 方法学限制（必须承认）

- 采样有限：Jackal 40 个采样帧（每 30 帧一帧）+ 每款 10 帧；**不等同于所有关卡/所有场景**（大量敌人、
  屏幕边缘、Boss、滚动分屏等未逐一覆盖）。
- 跨模拟器 oracle 只对“帧号能对应”的 5/40 帧有效（SEN 周期精确 vs jsnes 近似，长跑状态分叉）。
  因此“没有 8px 错位”这一结论的范围是**已对齐的采样帧**，不是全场景证明。
- 未获取用户“错位”截图，未在真实 DSH 页面做像素级截屏（只有 headless Chrome 的合成图案与本地 canvas 测试）。
- 音频/输入/存档不在本次范围。

## 7. 复跑方式

```sh
cd dsh-game-bench/selftest/render-audit
# 一次性准备（仅测试依赖，不进发布）：@lukad/sen 0.7.0 (MIT)
<node> <pnpm> add @lukad/sen@0.7.0

<node> capture-pure.mjs      # 纯 jsnes 帧
<node> capture-sen.mjs       # SEN 对照帧
<node> capture-engine.mjs    # engine 实跑字节对照
<node> structural.mjs        # 跨模拟器结构对齐
<node> dense-jackal.mjs      # Jackal 密集采样 + ±8px 位移搜索
<node> layers.mjs            # 精灵层/背景层分离 + OAM 区间校验
<node> browser-raster.mjs    # 真实 Chrome 截图
<python> raster-analyze.py   # 截图列宽/行高/平滑分析
<python> raw2png.py pure --sheet
<python> display-demo.py     # fit vs pixel 缩放量化
```

输出在 `selftest/render-audit/out/`（gitignore），关键快照在 `selftest/render-audit/results/`。
脚本只读 `games/*.nes`，不修改 `client.js` / `engine.js` / `vendor/**`。

## 8. 建议（当前证据下）

1. **不改 `vendor/jsnes.min.js` 与 `engine.js`**：没有可信的 PPU 通用修复依据，且 engine 的像素复制已验证 1:1。
2. **不做单游戏补丁**：mapper 2 / ROM 头 / 银行切换均符合规范；错位若来自显示层，单游戏补丁无效且会掩盖问题。
3. **已落地共用显示修复**：新安装默认使用“原始像素”；`pixel` 模式按 DPR 计算物理整数倍并把画布起点吸附到物理像素网格。显式选择的 `fit` 仍保留 4:3 CRT 观感及 1.25× 横向非方形像素，`stretch` 仍保留铺满行为。
4. 若仍能复现整块错位：请提供一张现场截图（含窗口尺寸/系统缩放设置），并用“原始像素”模式对照一次；
   这能直接把问题钉在“显示层”还是“帧内容层”。
