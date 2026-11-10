# selftest —— 拾光游戏厅离线验收 / 真实页面验收

真实 **headless Chrome + 真实 React 18 UMD + 真实 `client.js` + 真实 `engine.js`/jsnes**，
后端全部走本地 mock（`server.mjs`）。断言基于 `docs/CONTRACT.md` §4 的 `data-gb*` 钩子与真实 DOM / IndexedDB / canvas 像素。

## 运行

```bash
cd dsh-game-bench/selftest
node run.mjs            # 离线全量验收（约 2–3 分钟）
echo $?                 # 0 全绿 / 1 有 FAIL / 2 工件缺失 / 3 找不到 Chrome / 4 看门狗超时

node real-page.mjs      # 真实 DSH 页面验收（Lead 安装插件后）
echo $?                 # 0 全绿 / 1 有 FAIL / 2 插件未安装或页面需要鉴权 URL / 3 无 Chrome

node real-api.mjs       # 真实已安装插件的 Host 接口验收（不需要鉴权 URL）
echo $?                 # 0 无 FAIL（允许 SKIP）/ 1 有 FAIL / 2 插件路由不可达

cd .. && node server/selftest.mjs   # Host 真实路由自测（host-market 提供；临时数据目录 + 真实 GitHub）
```

- 无 npm 依赖：Node 24 自带 `WebSocket` / `fetch`；React 18 production UMD 离线在 `assets/`。
- Chrome 自动在 macOS / Windows / Linux 常见路径查找，也可 `CHROME_PATH=...`。
- 每次运行清空 `shots/*.png`；PASS/FAIL + 失败详情 + console 原文落盘 `last-run.log` / `real-page.log`。
- Chrome profile 写到 `tmp/`，结束清理；只写本目录，不碰插件源码与 `~/.dsh`。

### 真实页面鉴权

`real-page.mjs` 默认打开 `http://127.0.0.1:61254`。该地址根路径要求 `dsh web` 打印的鉴权 URL：
未带 token 时脚本会**明确报告 BLOCKED 并以退出码 2 结束**（不算 FAIL），可用：

```bash
DSH_URL="http://127.0.0.1:61254/?token=…" node real-page.mjs
```

### 基础设施自测（工件未交付 / 验证 harness 本身）

```bash
GB_INFRA=1 \
GB_CLIENT="$PWD/../../.lead-tmp/qa/smoke-client.js" \
GB_ENGINE="$PWD/../../.lead-tmp/qa/smoke-engine.js" \
GB_JSNES="$PWD/../../.lead-tmp/qa/smoke-jsnes.js" \
node run.mjs
```

`../../.lead-tmp/qa/` 下是 smoke fixture（最小 client + 假 engine），用于验证 CDP / 截图 / mock / 断言链路本身；
跑出的 PASS/FAIL 不代表真实插件质量。交付物不依赖它们。

## mock Host（`server.mjs`）

- 手柄模块：`/game-bench/api/gamepads.js`、`/gamepad-settings.js` 静态路由（文件存在才 200；`GB_GAMEPADS`/`GB_GAMEPAD_SETTINGS` 可覆盖）。
- 内置清单：与 Host 一致地合并 `../games/builtin.json`（公开 demo）+ `../games/builtin.local.json`
  （本机私有 7 款，gitignore），只保留文件存在的条目 → 本机 8 款；`/rom/<id>`、`/cover/<id>` 返回真实字节。
- 市场 96 款：从 `../../.lead-tmp/gb/library`（catalog 1131 款 + store 7 个合集）切片，含
  「魂斗罗」「坦克大战」等可搜索项；合集按 `store.json` 顺序，每个合集 ≥8 款用于市场首页。
- `/install` 延迟 300ms 后加入内存 library；`?mode=auth`（market/catalog 401）、`?mode=offline`（502）、
  `?mode=slow`（1.5s）；控制面 `POST /__config`、`GET /__calls`、`GET /__artifacts`、`POST /__reset`。
- `/engine.js`、`/vendor/jsnes.js`：文件存在才 200（否则 404，用于「运行时缺失」路径）。
  可用 `GB_CLIENT` / `GB_ENGINE` / `GB_JSNES` 覆盖被测文件路径。

## harness（`harness.html`）

- 假 DSH 三栏壳：侧栏（`sidebar.panellist` 槽 + 对话区输入框）、主区（`main` 槽 = `#root`）、假输入框。
- 假 `ctx`：`slots.inject/register`（记录 spec/组件）、`locale`（register/bind/subscribe）、`layout.selectPanel`、`effect`。
- 真加载 `engine.js` + `vendor/jsnes.min.js`（工件存在时由 server 注入 `<script>`）；拦截
  `GameBenchCore.create` 记录引擎实例、`onState.frames`、每次 `setButton`（因 engine api 是 `Object.freeze`，
  spy 返回一层代理对象），所以键盘断言不靠像素猜。
- `?view=library|market|player` 仅作为提示参数（真实视图由点击驱动）；`?mode=auth|offline|slow` 会在挂载前
  POST `/__config`。
- headless Chrome 会暴露「幽灵」标准手柄持续产生按键，**默认禁用 Gamepad**（`?gamepad=1` 保留）以保证键盘断言确定性。
- 只读助手：`__gbState/__gbCards/__gbCanvasStats/__gbIdb/__gbKey/__gbSetInput/__gbFocus`。

## 截图（`shots/`）

| 文件 | 内容 |
| --- | --- |
| `00-library-dark.png` | 游戏库（深色，内置 demo + 本机私有 7 款，共 8 张，含继续上次 hero） |
| `11-sidebar-entry.png` | 侧栏入口 6× 放大 |
| `01-player-start-overlay.png` | 播放器「点击开始」遮罩（CRT 扫描线） |
| `02-player-running.png` | 真实 NES 画面运行中（优先本机经典：超级玛丽 title）+ 底部控制条（默认 pixel 整数倍） |
| `02b-player-stretch.png` `02c-player-pixel.png` `02d-player-fullscreen.png` | 画面模式：铺满 / 切回 pixel 整数倍 / 真实全屏（CDP 手势触发 requestFullscreen） |
| `02e-player-crt.png` | 手动开启 CRT 滤镜（默认关闭） |
| `16-settings.png` | 设置页（画面模式三选一） |
| `02f-controls-hidden.png` `02g-controls-visible.png` `02h-fullscreen-hidden.png` | 控制条自动隐藏 / 底部唤出 / 全屏隐藏 |
| `02i-menu-context.png` `02j-menu-no-saves.png` | 库卡右键菜单（fixed 定位）/ 无存档空态 |
| `02k-player-pixel-dpr1.png` | 默认 pixel 模式 DPR=1 物理像素整数倍画面 |
| `17-settings-gamepad.png` | 设置页手柄面板（Pro 标准映射 / JoyCon 需校准 / 死区 / 校准入口） |
| `18-gamepad-calibrating.png` | 手柄校准进行态（输入可视化） |
| `03-keyboard.png` | 键盘输入后画面 |
| `05-save.png` | 存档到槽位 1（toast「已存入存档位 1」） |
| `06-load-restored.png` | 重置后读档恢复 |
| `07-market-dark.png` | 市场首页（合集 chips + 本周精选） |
| `08-market-search.png` | 市场搜索「魂斗罗」 |
| `09-market-installed.png` | 安装完成（已安装徽标 + 已安装·开玩） |
| `10-library-with-installed.png` | 安装市场游戏后游戏库 +1 张 |
| `11-market-auth-error.png` | 401 需要 GitHub 权限 + 去设置粘贴 Token / 重试 |
| `12-market-offline-error.png` | 502 连不上 GitHub + 重试 |
| `12b-offline-library.png` | 离线时内置游戏仍可玩 |
| `13-library-light.png` | 游戏库（浅色） |
| `14-600-narrow.png` `15-1440-wide.png` | 600 / 1440 宽，无横向溢出 |
| `real-*.png` | 真实 DSH 页面（侧栏入口 / 游戏库 / 播放中），插件安装后生成 |

## mock Host vs 真实 Host

`run.mjs` 验的是**真实 client.js / engine.js** 与 mock Host；真实 Host 路由（GitHub 下载、SHA 校验、
settings 权限、鉴权降级、手柄静态路由）由 `../server/selftest.mjs` 覆盖，QA 复跑：**133 PASS / 0 FAIL / 1 SKIP**
（SKIP＝资源库当前为公开仓库，私有仓库匿名用例不适用）。

## 三套验收的分工

| 脚本 | 被测对象 | 环境 | 结果（最近一次） |
| --- | --- | --- | --- |
| `run.mjs` | 真实 client.js + engine.js/jsnes + gamepads.js | 真实 Chrome + **mock Host** | PASS 182 / FAIL 0 |
| `real-api.mjs` | 真实 Host 路由（已安装插件） | 真实 DSH 进程 + 真实 GitHub | PASS 35 / FAIL 2（手柄静态路由需重装插件后转绿，见交付报告） |
| `real-page.mjs` | 真实 DSH 页面像素级 | 真实桌面窗口 | **BLOCKED**（根 URL 需 token） |
| `../server/selftest.mjs` | Host 路由（临时数据目录） | 真实 GitHub | 见交付报告 |

`real-page.mjs` 的 BLOCKED 不算 PASS；模块级证据（live slot 注册）由 Lead 的 `cordis_inspect_query` 提供。

## 内置清单说明（重要）

`games/builtin.json` 只含**作者原创 demo**（星光试航 Star Pilot，可随 MIT 插件分发）；插件所有者本机的
7 款经典 ROM 在 `games/builtin.local.json`（`.gitignore` 排除）。Host 合并两份清单，所以：
- 本机：内置 8 款（1 demo + 7 经典），截图/断言均按此；
- 干净 clone：内置 1 款 demo，验收脚本按 `/library.builtinCount` **动态**校验（不写死 7/8）。

## 本轮新增覆盖（2026-11-09）

- `[5b]` 控制条自动隐藏：窗口/全屏 2.5s 隐藏、底部 100px/顶部 48px/触屏唤出、游戏 keydown 不唤出、暂停/存档面板常显、
  隐藏时 opacity/pointer-events 真实生效、rAF 继续、退出后 window/document/player 监听净增 0
- `[5c]` 库卡右键菜单：fixed 定位、Esc/外部关闭、单菜单、普通 click 仍直接启动、重新开始不读档、
  从存档继续 `loadState` 字节与 IndexedDB 完全一致、`[data-gb-no-saves]` 空态、savedSlots 时间 = `timeText(updatedAt)`
- `[5d]` 手柄输入：fake 两台标准手柄 → 1P/2P 分离、A/START/RIGHT 边沿去抖、`ui.padProfiles` 字段
- `[5e]` 手柄设置页：标准 Pro + raw JoyCon 设备面板、合并 JoyCon 开关写 `ui.padPaired`、校准入口/进行态/取消 notice、无 console.error
- `[8b]` 渲染缩放诊断：canvas 无 CSS transform/zoom、image-rendering、pixel 模式 256/240 整数倍、DPR=2 设备像素对齐、
  fit 模式缩放比例记录（4:3 横向拉伸 1.25x，非整数倍是 8px tile 裂缝的观感来源；建议用设备像素整数倍策略）

## 已知局限

- 音频被 `--mute-audio` 静音，只断言 engine `audio` 状态，不验证真实发声（人工项）。
- 真实 GitHub 市场下载 / SHA 校验不在 mock 范围（人工项，见 CONTRACT §7）。
- 600px 截图里侧栏仍按 280px 宽渲染（harness 固定），真实 DSH 在窄屏会收起侧栏；因此响应式断言只覆盖面板内容不溢出。
- mock 市场是本地资源库切片（96 款），不是全部 1131 款；分页/懒加载封面只覆盖切片范围。
