# 拾光游戏厅（Game Bench）· 插件契约与验收 v1

本文是 Host / Client / 运行时 / 验收四方共用的唯一契约：接口以 `docs/API.md` 为准、模拟器以
`docs/ENGINE.md` 为准，**本文定义 UI 测试钩子与验收矩阵**。改实现前先改这里，或至少同步这里。

## 0. 标识

| 项 | 值 |
| --- | --- |
| npm 包名 | `@local/game-bench` |
| Loader 行 id | `game-bench`（`cordis.patch.yml`） |
| main 面板 key | `game-bench` |
| 侧栏图标 id | `game-bench`（`sidebar.panellist`，order 45） |
| Host 路由前缀 | `/game-bench/api` |
| 客户端 locale 命名空间 | `game-bench` |
| 客户端插件文件 | `client.js`（`window.__ModuleLoader__.load({ id, factory(require) {} })`） |
| 模拟器运行时 | `engine.js` + `vendor/jsnes.min.js`（经 `/game-bench/api/engine.js`、`/vendor/jsnes.js` 提供） |
| 客户端存档库 | IndexedDB `game-bench`（v1，object store `saves` / `progress` / `settings`） |

显示名：`拾光游戏厅`（en: `Game Bench`）。

## 1. 目录

```
dsh-game-bench/
├── package.json / cordis.patch.yml
├── index.js                 # Host：路由、市场鉴权/下载、内置清单（host-market）
├── client.js                # 浏览器：slots、游戏库、市场、播放器、存档、输入（panel-ui）
├── engine.js                # 模拟器封装 IIFE（emu-engine）
├── vendor/jsnes.min.js      # jsnes 2.1.0 原样分发（Apache-2.0）
├── games/                   # builtin.json（公开 demo）+ builtin.local.json（本机私有 7 款，gitignore）+ ROM/封面
├── locale/{zh,en}.json      # meta.title / meta.description
├── assets/icon-256.png      # 插件图标
├── docs/API.md              # Host HTTP 契约（规范）
├── docs/ENGINE.md           # 运行时契约（规范）
├── docs/CONTRACT.md         # 本文：UI 钩子 + 验收矩阵
└── selftest/                # 离线验收（真实 Chrome + 真实 client.js/engine.js + mock Host）
```

## 2. Host API（规范见 `docs/API.md`）

验收只依赖以下行为，mock 全部按此实现（`selftest/server.mjs`）：

- `/status` 永远 200；含 `builtinCount/installedCount/market.{auth,ready,catalogGames,lastSync,error}/vendor.{jsnes,engine}`。
- `/library` 内置游戏始终 `installed:true`，离线可用。内置清单 = `games/builtin.json`（可公开分发的
  demo：星光试航 Star Pilot）+ `games/builtin.local.json`（本机私有 7 款经典，被 `.gitignore` 排除，
  干净 clone 下不存在）；Host 合并两份 manifest、同 id local 覆盖 public、文件不存在的条目静默跳过。
  **因此「内置数量」是动态的**：本机 8 款（1 demo + 7 私有），公开 clone 仅 1 款；验收断言按 `/library.builtinCount` 动态校验。
- `/catalog?q=&collection=&offset=&limit=`、`/market`：`q` 大小写不敏感匹配 `title`/`sourceNames`（含中文）。
- `/install` 幂等、300ms 级延迟；`/uninstall`；`/rom/<id>`、`/cover/<id>` 返回真实字节。
- 失败一律返回 `{ok:false,error,code}` 信封；`AUTH`（401）/`NETWORK`（502）两种错误态 UI 必须可渲染。
- `/settings` GET/POST（token 不回显）；`/sync` 强制刷新。
- `/vendor/jsnes.js`、`/engine.js`：`application/javascript`，文件缺失 404（面板显示「模拟器运行时缺失」，不得崩溃）。

## 3. Client slots（`client.js` `apply(ctx)`）

```js
inject: ['slots', 'locale', 'layout']           // 必须声明 slots
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'game-bench' }, Page))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'game-bench', order: 45,
  label: () => t('meta.title'),
}, PanelIcon))
```

- `apply` 内副作用（style、keyboard、IndexedDB、fetch）都要经 `ctx.effect` 注册并返回清理函数。
- 卸载/切面板时 `releaseAll()` 按键、停止帧循环、清理监听。

## 4. 页面结构与测试钩子（硬性；验收脚本按此断言）

主面板根节点 `[data-gb="root"]`，高度 100%，自己滚动，不 fixed / 不悬浮。

| 钩子 | 位置 | 语义 |
| --- | --- | --- |
| `[data-gb="root"]` | main 面板根 | 必须存在；`data-gb-view="library\|market\|player"` 反映当前视图 |
| `[data-gb-tab="library"\|"market"]` | 顶栏 tab | 点击切换游戏库 / 市场（也接受文本「游戏库」「市场」兜底匹配） |
| `[data-gb-search]` | 搜索输入框 | 输入过滤标题；市场搜索走 `/catalog?q=` |
| `[data-gb-card]` | 游戏卡片 | **属性值 = gameId**；可选 `data-installed="true"`；内含 `<img>` 封面与标题文本 |
| `[data-gb-collection="<id>"]` | 市场合集 chip | 至少 2 个，文字含合集名与数量 |
| `[data-gb-install]` | 市场卡片/详情安装按钮 | 点击触发 `POST /install`；成功后该卡 `data-installed="true"` 且文案「已安装」 |
| `[data-gb-start]` | 播放器开始遮罩 | 进入播放器后出现，点击开始模拟器 |
| `[data-gb-save]` / `[data-gb-save-1]` | 存档按钮 | 写入 IndexedDB `saves`，key `<gameId>#<slot>` |
| `[data-gb-load]` / `[data-gb-load-1]` | 读档按钮 | 从 IndexedDB 恢复 |
| `[data-gb-reset]` | 重置按钮 | engine `reset()` |
| `[data-gb-back]` | 返回按钮 | 返回游戏库 |
| `[data-gb-error]` | 错误态容器 | `AUTH` / `NETWORK` 时出现，含可读中文文案 + 重试按钮 |
| `[data-gb-toast]` | 轻提示 | 安装/存档/读档/崩溃等反馈 |
| `[data-gb-entry]` | 侧栏入口 | `sidebar.panellist` 渲染的入口按钮（真页验收用；也可用 `aria-label` 含「游戏」） |

播放器：`[data-gb="root"] canvas`，内部分辨率固定 **256×240**（engine 只设内部分辨率，
CSS 缩放/`image-rendering: pixelated` 由 client 负责），画布必须真实绘制（非全黑像素 > 500）。

## 5. 客户端存储（IndexedDB）

- 库名 `game-bench`，版本 1。
- `saves`：key `<gameId>#<slot>`（slot = `auto|1|2|3`），value `{gameId, slot, title, state: Uint8Array, updatedAt, label}`。
- `progress`：key `<gameId>`，value `{gameId, lastPlayedAt, playSeconds, title}`。
- `settings`：key `ui`，value `{volume, muted, speed, scale, crt, showFps, keys}`。
- 读档前必须有 ROM；存档体积 gzip 后 < 250 KB（ENGINE.md）。

## 6. 行为要求

### 6.1 游戏库
内置 7 款卡片（`[data-gb-card]`），真实封面（`naturalWidth>0`）与标题；市场已安装游戏追加其后。
离线（`/library` 本地 + 内置 ROM）必须可玩。

### 6.2 市场
tab 切换 → 合集 chips + 卡片；搜索命中（「魂斗罗」「坦克大战」）；安装 → 卡片「已安装」+ 游戏库 +1。
`AUTH`：显示「市场需要 GitHub 访问权限…」+ 重试；`NETWORK`：显示「连不上 GitHub…（内置游戏不受影响）」+ 重试。
错误态不得导致页面崩溃或丢内置游戏。

### 6.3 播放器与输入
点卡片 → `player` 视图 + `[data-gb-start]` → 点开始 → canvas 256×240 真实像素、帧推进（连续两次像素不同）。
键盘：`ArrowUp/Down/Left/Right`、`Z`(A)、`X`(B)、`Enter`(START)、`Shift`(SELECT)；
**焦点在 `input/textarea/[contenteditable]` 时一律不接管、不 `preventDefault`、不 `setButton`**；
失焦 / 切面板 `releaseAll()`。engine 不得绑定 document 级键盘（由 client 决定）。

### 6.4 存档
存档 → IndexedDB `saves` 出现 `<gameId>#1`（state 字节 > 1000）；重置 → 读档 → 画面恢复（canvas 非全黑）+ 可读反馈。

### 6.5 主题 / 响应式
颜色只用 DSH 主题 token（`--dsw-alias-*`），深色 / 浅色都可用；600 / 1440 两档
`scrollWidth ≤ clientWidth + 2`（无横向溢出）；面板根节点在 600px 下仍有可用宽高。

## 7. 验收矩阵

| # | 条目 | 验证方式 | 覆盖 |
| --- | --- | --- | --- |
| 1 | 模块可加载、`inject` 含 slots、main + sidebar.panellist 注册（id/order/label） | 离线 harness | `run.mjs [1]` |
| 2 | 游戏库内置卡片数 = `/library.builtinCount`（本机 8 张：demo + 私有 7 款）、真实封面/标题 | 离线 harness | `run.mjs [2]` |
| 3 | 播放器：视图、开始遮罩、canvas 256×240、非黑像素 > 500、帧推进 | 离线 harness | `run.mjs [3]` |
| 4 | 键盘：engine 收到按键（按下+抬起）、画面变化；输入框不抢键/不 preventDefault、打字正确 | 离线 harness | `run.mjs [4]` |
| 5 | 存档：IndexedDB `<gameId>#1`、state > 1000B、重置后读档恢复 | 离线 harness | `run.mjs [5]` |
| 6 | 市场：合集 chips、卡片、搜索「魂斗罗/坦克大战」、安装 → 已安装 + 库 +1 | 离线 harness | `run.mjs [6]` |
| 7 | 错误态：AUTH 401 引导 + 重试；NETWORK 502 降级说明 + 重试；内置游戏仍可用 | 离线 harness | `run.mjs [6]` |
| 8 | 主题：深/浅色 token 生效、面板颜色随主题变化 | 离线 harness | `run.mjs [7]` |
| 9 | 响应式：600 / 1440 无横向溢出、面板有可用尺寸 | 离线 harness | `run.mjs [8]` |
| 10 | 运行期：无未捕获异常 / console.error、engine 无 crashed | 离线 harness | `run.mjs [9]` |
| 10b | 全部内置 ROM（本机 8 款）经真实 engine 渲染非黑 + saveState/loadState（gzip）往返 | 离线 harness | `run.mjs [3b]` |
| 10c | Host 真实路由：/status /library /catalog /market /rom /cover /install /uninstall /settings /sync、SHA 校验、并发去重、鉴权降级 | Host 自测（host-market 提供，QA 复跑） | `node server/selftest.mjs` |
| 11 | 真实 DSH 页面：侧栏入口出现、点击开面板、库、开始、canvas 非黑且帧在动 | 真页 — **BLOCKED**（桌面版根 URL 需 `dsh web` 打印的带 token URL，无法从环境自取） | `real-page.mjs`（未鉴权时退出码 2，不误报 FAIL） |
| 11b | 真实环境模块级证据：live Client `sidebar.panellist` 出现 `{id:"game-bench", order, active:true}`、`main` 槽已注册 | 真页（`cordis_inspect_query`，Lead 执行） | 已确认（见 §7.1） |
| 11c | 真实 Host 接口：/status、/library、7 款 ROM 字节+SHA、7 张封面 PNG、jsnes/engine.js、/market 1131 款、真实 install→SHA 校验→uninstall 回滚 | 真实环境（不需要鉴权） | `real-api.mjs` |
| 12 | 真实页面音频实际发声、真实像素级目视、手柄 | 人工（Lead/用户） | 不在自动脚本范围（headless 静音） |

### 7.1 真实页面验收现状（不写成 PASS）

- `real-page.mjs` 对 `http://127.0.0.1:61254` 返回 401 `dsh web authentication required`；桌面版走
  `dsh-app://` 内部通道，带 token 的外链 URL 只在启动终端打印，环境中不可得。**该项标记 BLOCKED**。
- 可获得的真实环境证据（均已实际执行）：
  1. **模块级**：live Client `sidebar.panellist` occupants 含 `{ id: "game-bench", active: true }`，`main` 槽 key 域放开
     —— 证明真实 DSH 页面里 `client.js` 已加载、两个 slot 注册成功（Lead 用 `cordis_inspect_query` 取得）。
  2. **Host 接口级**：`real-api.mjs` 直接打真实插件路由，全部通过（含真实 GitHub 目录 1131 款、
     真实下载 262160B + SHA-256 校验 + 卸载回滚），见其输出。
  3. **客户端/引擎级**：`run.mjs` 用真实 `client.js` + 真实 `engine.js`/jsnes 在真实 Chrome 里跑通 80 条断言。
- 仍缺：真实页面里的**像素级**渲染与真实音频/手柄 —— 需人工在桌面窗口复核，见上表 12。

**人工项**（诚实标注，自动化不覆盖）：真实音频输出（headless `--mute-audio`）、
真实 GitHub 市场下载与 SHA 校验、桌面窗口下的像素级目视（字体/对比度/动效）、手柄输入。

## 8. 离线验收环境（`selftest/`）

```bash
cd dsh-game-bench/selftest
node run.mjs              # 真实 Chrome + 真实 client.js/engine.js + mock Host
                          # 退出码 0 全绿 / 1 有 FAIL / 2 工件缺失 / 3 无 Chrome
node real-page.mjs        # 真实 DSH 页面（需 Lead 安装插件 + 鉴权 URL；未就绪退出码 2）
node real-api.mjs         # 真实已安装插件的 Host 接口（不需要鉴权；真实 GitHub 目录/下载/SHA/卸载）
cd .. && node server/selftest.mjs   # Host 真实路由自测（host-market 提供，真实 GitHub/临时数据目录）
```

- mock Host（`server.mjs`）：内置清单与 Host 相同地合并 `../games/builtin.json` + `../games/builtin.local.json`
  并读真实 ROM/PNG（本机 8 款）；市场 96 款切片自
  `../../.lead-tmp/gb/library`（catalog 1131 款 + store 7 个合集），`/rom/<id>`、`/cover/<id>` 返回真实字节。
- 失败模式：`?mode=auth`（market/catalog 401 AUTH）、`?mode=offline`（502 NETWORK）、`?mode=slow`（1.5s 延迟）；
  也可 `POST /__config {"mode":"auth"}`。
- 离线 harness 的 Host 是 **mock**（`selftest/server.mjs`，按 API.md 实现）；真实 Host 路由由
  `node server/selftest.mjs` 覆盖（临时数据目录 + 真实 GitHub，不碰 `~/.dsh`）。
- harness（`harness.html`）：真实 React 18 UMD + 真 `client.js` + 假 `ctx`（slots/locale/layout）+ 真
  `engine.js`/`jsnes`（工件存在时 preload）。`window.__gbEngines` 记录 engine 实例、`onState.frames`、
  每次 `setButton`；因此键盘断言不依赖画面像素猜测。
- 截图 `shots/*.png`：`00-library-dark` / `01-player-start-overlay` / `02-player-running` / `03-keyboard` /
  `04-search` / `05-save` / `06-load-restored` / `07-market-dark` / `08-market-search` / `09-market-installed` /
  `10-library-with-installed` / `11-market-auth-error` / `12-market-offline-error` / `13-library-light` /
  `14-600-narrow` / `15-1440-wide` / `11-sidebar-entry`；真页 `real-*.png`。日志 `last-run.log`、`real-page.log`。

## 9. 非目标

- 不做在线联机 / 存档云同步 / 金手指 / 录像 / 多人手柄映射 UI。
- 不修改 jsnes 源码；不改网易云 / 电台 / 佳明插件。
- 不做移动端原生布局重构（Web 响应式即可）。
