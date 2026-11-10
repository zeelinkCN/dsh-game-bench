# Game Bench Host API 契约（v1）

插件包：`@local/game-bench`
Host 入口：`index.js`，`export const inject = ['webServer']`，`export function apply(ctx)`
所有 HTTP 接口由 `ctx.webServer.register(...)` 注册在 **同源** 路径下，由 Client `client.js` 用 `fetch` 调用。

## 0. 通用约定

- 前缀：`/game-bench/api`
- JSON 信封：
  - 成功 `{ "ok": true, "data": <payload> }`
  - 失败 `{ "ok": false, "error": "人话错误信息", "code": "AUTH|NETWORK|NOT_FOUND|SHA_MISMATCH|UNSUPPORTED|INTERNAL|BAD_REQUEST" }`
  - HTTP 状态码：成功 200；参数错 400；无权限/未登录 401/403 视情况；找不到 404；上游失败 502；内部 500。
  - 但 **即使非 200 也返回上面的 JSON 信封**（二进制路由除外）。
- 所有响应带 `Cache-Control: no-store`（除明确标注可缓存的）。
- 二进制路由：`/rom/<id>`、`/cover/<id>` 直接返回字节，不套 JSON。
- `id` 形如 `nes-<sha256>`（内置游戏与市场游戏同一命名空间，内置游戏 id 取自内置清单）。
- 任何上游失败都必须降级为可读错误，**不得导致插件激活失败**；`/status` 永远 200。

## 1. `GET /status`

用于面板顶部健康检查、市场登录状态提示。

```json
{
  "ok": true,
  "data": {
    "version": "1.1.0",
    "builtinCount": 7,
    "installedCount": 0,
    "dataDir": "/Users/xxx/.dsh-game-bench",
    "market": {
      "repo": "zeelinkCN/game-bench-library",
      "auth": "gh",           // "settings" | "env" | "gh" | "public" | "none"
      "ready": true,          // 是否能读到 catalog
      "catalogGames": 1131,
      "lastSync": 1762000000000,
      "error": null
    },
    "vendor": { "jsnes": true, "engine": true }
  }
}
```

`auth` 取值含义：
- `settings`：用户在设置里粘贴了 Personal Access Token（保存在 `<dataDir>/settings.json`，0600）
- `env`：`GITHUB_TOKEN` / `GH_TOKEN` 环境变量
- `gh`：自动从本机 `gh auth token` 取得（macOS/Windows 都适用；gh 未登录时为 `none`）
- `public`：仓库已公开，走匿名 raw 下载
- `none`：都没有 → 市场页要显示「需要 GitHub 访问权限」引导

## 2. `GET /library`

游戏库 = 内置 7 款 + 已下载的市场游戏。**离线可用**。

```json
{
  "ok": true,
  "data": {
    "builtinCount": 7,
    "installedCount": 2,
    "games": [
      {
        "id": "nes-ec299b990e8bfee8ba46e3f61d63b2e1ae5b8a2e431de84e2e4bbd692dc53586",
        "title": "超级玛丽1",
        "cover": "/game-bench/api/cover/nes-ec29...",
        "rom": "/game-bench/api/rom/nes-ec29...",
        "builtin": true,
        "installed": true,
        "size": 40976,
        "sha256": "ec299b99...",
        "source": "https://github.com/mengfei523060/nesrom",
        "sourceNames": ["超级玛丽1"],
        "language": "",          // "" 或 "zh" 或 "zh-label"
        "tags": ["童年经典"],
        "series": "",
        "featuredRank": 1         // 内置游戏有，市场游戏没有则为 0
      }
    ]
  }
}
```

规则：
- 内置游戏始终 `installed: true`。内置清单分两份并合并（v1.1）：
  `games/builtin.json`（可公开：作者自制 demo）+ `games/builtin.local.json`（本机私有：经典 ROM，gitignore），
  同 id 时 local 覆盖 public；ROM 文件缺失的条目会被跳过，`/library` 只列出可用条目（内置 id 不一定是 `nes-<sha256>`，
  自制 demo 例如 `starpilot`）。
- 已下载游戏从 `<dataDir>/library.json` 读取；文件缺失/损坏按空处理，不抛错。
- 排序：内置按 `featuredRank`，其后已下载按 `installedAt` 倒序。

## 3. `GET /catalog?q=&collection=&offset=0&limit=60`

市场浏览。数据来自资源库 `catalog.json`（首次访问时拉取并落盘缓存，TTL 24h；`/sync` 可强制刷新）。只返回 `system: "nes"` 的可玩条目。

```json
{
  "ok": true,
  "data": {
    "total": 1131,
    "offset": 0,
    "limit": 60,
    "items": [
      {
        "id": "nes-69084b4f...",
        "title": "魂斗罗 (简)",
        "cover": "/game-bench/api/cover/nes-69084b4f...",
        "sha256": "69084b4f...",
        "source": "https://github.com/tomiaa12/nesRoms",
        "sourceNames": ["魂斗罗 (简)"],
        "language": "zh-label",
        "series": "",
        "builtin": false,
        "installed": true
      }
    ]
  }
}
```

- `q`：大小写不敏感，匹配 `title` 与 `sourceNames` 任一项（含中文）。
- `collection`：按 `store.json` 的合集 id 过滤（`childhood` 等），保持合集内顺序。
- 目录不可用时返回 `{ok:false, code:"AUTH"|"NETWORK"}`，由 Client 渲染市场错误态 + 重试按钮。

## 4. `GET /market`

市场首页数据：合集 + 每个合集前 8 款 + 总数。

```json
{
  "ok": true,
  "data": {
    "title": "拾光游戏市场",
    "libraryVersion": "2026-11-06",
    "total": 1131,
    "auth": "gh",
    "collections": [
      { "id": "childhood", "title": "童年经典", "description": "精选的小霸王与红白机回忆", "total": 40, "games": [ MarketGame x8 ] }
    ],
    "featured": [ MarketGame x12 ]   // 目录中 featuredRank 前 12（作为「本周精选」）
  }
}
```

## 5. `POST /install`

下载一款市场游戏（ROM + 封面），校验 SHA-256，写入 `<dataDir>/roms/<id>.nes` 与 `<dataDir>/covers/<id>.png`，更新 `library.json`。

请求：`{ "id": "nes-..." }`
响应：`{ "ok": true, "data": { "game": LibraryGame, "bytes": 393232, "cover": true } }`

- 幂等：已安装直接返回成功。
- 校验失败：删除半成品，返回 `code:"SHA_MISMATCH"`，错误文案带期望/实际摘要前 12 位。
- 单款下载超时 30s；失败不留垃圾文件。
- 同一 id 并发安装需去重（复用同一个 Promise），避免重复请求 GitHub。

## 6. `POST /uninstall`

请求：`{ "id": "nes-..." }` → `{ "ok": true, "data": { "id": "...", "removed": true } }`
删除 ROM 与封面缓存、从 `library.json` 移除。存档由 Client 侧的 IndexedDB 管理，Host 不删。

## 7. `GET /rom/<id>`

返回 ROM 原始字节。查找顺序：内置 `games/<file>` → `<dataDir>/roms/<id>.nes`。
响应头：`Content-Type: application/octet-stream`、`Content-Length`、`Cache-Control: no-store`（内置游戏可 `private, max-age=86400`）。
找不到 → 404（JSON 信封）。

## 8. `GET /cover/<id>`

返回封面图。查找顺序：内置 `games/<id>.png` → `<dataDir>/covers/<id>.png` → 市场游戏按目录里的 `cover` 路径**懒加载**并缓存（并发上限 4，LRU 磁盘缓存）。
找不到 / 拉取失败 → 404，Client 渲染标题色块占位，不报错。
成功时 `Cache-Control: private, max-age=604800`。

## 9. `GET /vendor/jsnes.js` 与 `GET /engine.js`

分别返回 `vendor/jsnes.min.js`（jsnes 2.1.0 UMD，原样分发，Apache-2.0）与 `engine.js`（自研封装，见 `docs/ENGINE.md`）。
`Content-Type: application/javascript; charset=utf-8`、`Cache-Control: public, max-age=604800`。
Client 用 `<script>` 顺序加载（jsnes 先、engine 后），失败时面板显示「模拟器运行时缺失」。

## 10. `POST /sync`

强制重新拉取 `catalog.json` + `store.json`（忽略 TTL），返回 `{ ok:true, data: { total, collections, lastSync, auth } }`。
上游失败保留旧缓存并返回 `{ ok:false, code:"AUTH"|"NETWORK" }`：401/403/仓库不存在/无权限（含匿名访问私有仓库的 404）归 `AUTH`，超时/5xx/429/连不上归 `NETWORK`。

## 11. `GET /settings` 与 `POST /settings`

```json
// GET
{ "ok": true, "data": { "repo": "zeelinkCN/game-bench-library", "hasToken": false, "tokenSource": "gh", "dataDir": "..." } }
// POST body（字段可选）
{ "repo": "zeelinkCN/game-bench-library", "token": "github_pat_..." }
```
`token` 为 `""` 时清除已保存的 token。token 只写入 `<dataDir>/settings.json`（权限 0600），**绝不回显**。
非法 repo 格式（必须 `owner/name`）→ 400 `BAD_REQUEST`。

## 12. 客户端存储约定（Host 不参与）

Client 用 IndexedDB（库名 `game-bench`，版本 1）：
- `saves`：key `<gameId>#<slot>`，value `{ gameId, slot, title, state: Uint8Array, updatedAt, label }`，slot = `auto|1|2|3`
- `progress`：key `<gameId>`，value `{ gameId, lastPlayedAt, playSeconds, title }`
- `settings`：key `ui`，value `{ volume, muted, speed, scale, crt, showFps, keys }`
内置 7 款的「打开即玩」只依赖 `/library` + `/rom/<id>`，断网也能玩。

## 13. 错误码与文案要求

| code | 场景 | 建议中文文案 |
|---|---|---|
| AUTH | 无 GitHub 访问权限 / 401 / 403 | 市场需要 GitHub 访问权限，请在设置里粘贴 Token，或先执行 `gh auth login` |
| NETWORK | 上游超时 / 5xx / DNS | 连不上 GitHub，请检查网络后重试（内置游戏不受影响） |
| NOT_FOUND | 目录里没有该 id / 文件不存在 | 找不到这款游戏，可能已从资源库移除 |
| SHA_MISMATCH | 校验不一致 | 文件校验失败，已删除半成品，请重试 |
| UNSUPPORTED | 非 NES / 浏览器不支持 | 暂不支持这个平台 |
| INTERNAL | 其他 | 出现意外错误：<detail> |

## 14. 测试用固定数据

- 内置清单：`games/builtin.json`（7 款，含 sha256/size/cover/source）
- 资源库目录：`.lead-tmp/gb/library/catalog.json`（开发期本地副本，1131 款）
- 资源库市场：`.lead-tmp/gb/library/store.json`
- 本机已验证的鉴权方式：`gh auth token`（账号 `zeelinkCN`，scope 含 repo）
- 已验证下载：`GET https://api.github.com/repos/zeelinkCN/game-bench-library/contents/owned/<sha>.nes?ref=main` 带 `Authorization: Bearer <token>` + `Accept: application/vnd.github.raw`，返回原始字节且 SHA-256 与目录一致

## 15. Host 实现备注（v1 落地细节，2026-11-08）

本节记录 `index.js` + `server/*.mjs` 的实际实现细节，是对上面条目的补充（不改变接口形状）。

### 15.1 模块划分

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：`inject: ['webServer']`，装配 store/builtin/market，`ctx.effect` 内注册全部路由并返回释放函数 |
| `server/paths.mjs` | 跨平台数据目录、各文件路径、常量（`ROUTE`/`VERSION`/`DEFAULT_REPO`/`ID_RE`） |
| `server/fsutil.mjs` | 原子写（同目录 `.tmp` + `rename`）、JSON 读写、串行队列、SHA-256 |
| `server/builtin.mjs` | 合并 `games/builtin.json`（公开 demo）+ `games/builtin.local.json`（本机私有），跳过缺失文件条目 |
| `server/store.mjs` | `library.json`（单队列串行读改写）+ `settings.json`（0600，只写不读不回显） |
| `server/github.mjs` | 鉴权解析（settings→env→gh→public→none，内存缓存 10 分钟）+ 资源库文件下载 + 错误归类 |
| `server/market.mjs` | 目录缓存（24h TTL / 强刷 / 失败保全）、`/catalog` `/market` 数据、安装卸载、封面懒加载 |
| `server/http.mjs` | 路由表、JSON 信封、二进制路由、`/status` 兜底 |
| `server/selftest.mjs` | 独立自测（fake ctx + 本地 http server，不依赖 DSH） |
| `scripts/pack-builtins.mjs` | 从资源库按 `featuredRank` 生成 `games/` + `builtin.json`（幂等） |

### 15.2 数据目录与文件

- 解析顺序：`DSH_GAME_BENCH_DATA` → macOS `~/Library/Application Support/DSH Game Bench` → Windows `%APPDATA%\DSH Game Bench` → Linux `$XDG_DATA_HOME/dsh-game-bench` 或 `~/.local/share/dsh-game-bench`。
- 目录惰性创建（写入前 `mkdir -p`）；解析失败回落 `~/.dsh-game-bench`，不抛异常。
- 文件：
  - `catalog.json`：资源库目录**原始字节**（数组），文件 mtime 即 `lastSync`
  - `store.json`：资源库市场配置原始字节（`{ title, libraryVersion, collections: [{ id, title, description, gameIDs }] }`）
  - `library.json`：`{ version:1, updatedAt, games:[{ id,title,sha256,size,source,sourceNames,language,series,author,installedAt }] }`；损坏/缺失按空处理
  - `settings.json`：`{ version:1, repo, token, updatedAt }`，权限 `0600`，`token` 字段永不回显
  - `roms/<id>.nes`、`covers/<id>.png`：原子写入；卸载时一并删除
- 内置清单（随插件包，不在数据目录）：
  - `games/builtin.json`：可公开分发（作者自制 demo，id 可为 `starpilot` 这类短 id）
  - `games/builtin.local.json`：本机私有（经典 ROM，gitignore；同 id 覆盖 public）
  - 两份清单都只列出「ROM 文件真实存在」的条目；封面缺失时 `/cover` 返回 404 由前端画占位

### 15.3 鉴权与上游

- 解析顺序与 `/status.market.auth`、`/settings.tokenSource` 的取值一致：`settings | env | gh | public | none`。
- `gh auth token`：`execFile`（`shell:false`，5s 超时，`ENOENT` 降级），Windows 依次尝试 `gh.exe`/`gh` 与常见安装路径，Unix 尝试 `gh`、`/opt/homebrew/bin/gh`、`/usr/local/bin/gh`、`~/.local/bin/gh`。
- 有 token 走 `https://api.github.com/repos/<repo>/contents/<path>?ref=main`（`Accept: application/vnd.github.raw`）；无 token 走 `https://raw.githubusercontent.com/<repo>/main/<path>`（仅公开仓库）。
- 传输层**不用**全局 `fetch`（undici）；用 Node 内置 `node:https` 并**强制 IPv4**（`family: 4`）：
  本机双栈网络里 IPv6 连接会卡死 `api.github.com`（实测 30s+），强制 IPv4 后 0.6–2.1s。
  IPv4 解析/路由不可用时自动回退系统默认解析。
- `https` 出现 NETWORK 级失败时（超时/5xx/429/连接错误），若本机 `gh` 可用则回退
  `gh api repos/<repo>/contents/<path>?ref=main -H "Accept: application/vnd.github.raw"`（二进制安全，已验证字节与 SHA-256）。
  成功过的传输方式在进程内记忆并优先复用，失败自动回退另一种。
- 目录/市场配置（catalog.json、store.json）采用**对冲请求**：`https` 6s 未完成就并行启动 `gh` 兜底，谁先成功用谁，
  避免网络抖动时用户干等 30s+；成功日志形如 `[transport=https] catalog.json 904895B 1193ms`（绝不打印 token）。
- 目录文件下载超时 45s（首次冷启动），ROM/封面单款 30s。
- 无 token 且拉取失败统一返回 `AUTH`（引导粘贴 Token / `gh auth login`），不会静默失败。
- 设置里切换 `repo` 会清空 `catalog.json`/`store.json` 缓存并重新解析鉴权，避免旧仓库数据串味。

### 15.4 缓存与降级

- `catalog.json`/`store.json` TTL 24h；过期后尝试刷新，失败保留旧缓存并记录 `/status.market.error`。
- 连续失败时 2 分钟冷却，离线浏览不会每次请求都等上游超时。
- 强刷（`/sync`）两个文件都下载并解析成功后才原子落盘；失败时旧文件保持不变。
- `/status` 内部所有异常都降级为兜底数据，**永远 200**。
- 激活时（路由注册后）fire-and-forget 调 `market.prefetch()` 后台预热目录：不阻塞激活、失败只 log；
  预热成功后 `/status.market.ready/catalogGames/lastSync` 立即反映（用户第一次开市场不用等网络）。

### 15.5 二进制路由细节

- `/rom/<id>`：查找顺序内置 `games/<id>.nes` → `<dataDir>/roms/<id>.nes`；**不**懒下载。
  内置 `Cache-Control: private, max-age=86400`，已下载 `no-store`；找不到返回 404 + JSON 信封。
- `/cover/<id>`：内置 → 本地缓存 → 按目录 `cover` 路径懒加载（全局并发上限 4、in-flight 去重、失败缓存 5 分钟）；
  成功 `Cache-Control: private, max-age=604800`；找不到/拉取失败返回 404 **空响应体**（`<img>` 直接渲染占位，不解析 JSON）。
- `/vendor/jsnes.js`、`/engine.js`：读磁盘文件返回，缺失返回 404 空脚本（前端显示「模拟器运行时缺失」），插件不崩。

### 15.6 并发与幂等

- `/install` 按 id 去重（共享同一个 Promise），并发安装同一款只请求一次上游；成功后再装直接返回 `alreadyInstalled:true`（若 ROM 文件丢失会重新下载）。
- 所有 `library.json` 写操作走单队列串行，安装/卸载不会互相覆盖。
- 安装体积上限：ROM 8MB、封面 2MB；单请求超时 30s；SHA-256 不一致 → 删除半成品并返回 `SHA_MISMATCH`（文案带期望/实际摘要前 12 位）。
- 封面下载失败不影响安装成功（`cover:false`）。
- 卸载内置游戏为 no-op：`{ ok:true, data:{ id, removed:false, builtin:true } }`（内置 id 可以是任意安全短 id，例如 `starpilot`）。

### 15.7 错误码 → HTTP 状态码

| code | HTTP |
|---|---|
| `BAD_REQUEST` | 400 |
| `AUTH` | 401 |
| `NOT_FOUND` | 404 |
| `NETWORK` | 502 |
| `SHA_MISMATCH` | 502 |
| `UNSUPPORTED` | 400 |
| `INTERNAL` | 500 |

### 15.8 自测与打包

```bash
# Host 独立自测（fake ctx + 本地随机端口；GitHub 不可达时网络用例记 SKIP）
node dsh-game-bench/server/selftest.mjs          # 退出码 0 全绿

# 重新生成本机私有内置清单（幂等；ROM/封面 SHA 校验；内容不变则不重写）
# 产出 games/<id>.nes、games/<id>.png、games/builtin.local.json；不动可公开的 games/builtin.json
node dsh-game-bench/scripts/pack-builtins.mjs [--count 7] [--force] [--library <dir>]
```

