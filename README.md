# 拾光游戏厅 · Game Bench

DSH（DeepSeek Harness）插件：左侧栏一个手柄图标，点开就是一台跑在浏览器里的红白机。

- **打开即玩**：面板一开就是游戏库，点卡片立刻开局；内置 demo 随包分发，断网也能玩。
- **内置游戏市场**：接 `zeelinkCN/game-bench-library`（1100+ 款、带封面与 SHA-256），按合集/搜索挑选，点一下下载安装，装完立刻开玩；ROM 与封面落盘缓存，之后离线可玩。
- **真模拟器**：jsnes 2.1.0 在浏览器里跑 60fps（实测 0.9ms/帧），Web Audio 立体声、键盘/手柄、4 个存档槽（含自动存档）、倍速、CRT 滤镜、截图、全屏。
- **跨平台**：macOS / Windows / Linux 同一份代码，只要有 DSH Web UI 就能玩。存档在浏览器 IndexedDB。

```
┌─ 左侧栏 ─┐   ┌──────────── 拾光游戏厅 ──────────────┐
│  💬 对话  │   │  游戏库     游戏市场           ⚙ 设置 │
│  🎮 游戏厅│   │  ┌──────┐ ┌──────┐ ┌──────┐         │
│  📻 电台  │   │  │ 封面  │ │ 封面  │ │ 封面  │   ...   │
│  🎵 音乐  │   │  └──────┘ └──────┘ └──────┘         │
└──────────┘   └──────────────────────────────────────┘
```

## 安装

```sh
# 从本仓库目录安装（开发/自用）
plugin_manager install_bundle target=/path/to/dsh-game-bench
```

安装后左侧栏出现手柄图标，无需重启；若图标未出现，刷新页面。

## 操作

| 功能 | 键盘 | 手柄 |
| --- | --- | --- |
| 方向 | `↑ ↓ ← →` | 十字键 / 左摇杆 |
| B（跳/开火） | `Z` | A |
| A（跑/跳弹） | `X` | B |
| Start | `Enter` | Menu / Start |
| Select | `Shift` | View / Back |
| 暂停 / 返回 | `Space` / `Esc` | — |
| 2P | `WASD` + `J`/`K` | 第二只手柄 |

存档：工具栏「存档 / 读档」→ 3 个手动槽 + 自动槽（每 60 秒、暂停、退出、页面切走时自动写入）。存档存在本机浏览器（IndexedDB），删除游戏不会删档。

## 游戏市场

市场读取私有资源库 `zeelinkCN/game-bench-library` 的 `catalog.json` / `store.json`，需要 GitHub 读权限。Host 侧查找凭据的顺序：

1. 插件设置里粘贴的 Personal Access Token（保存到数据目录 `settings.json`，权限 0600，只写不读）
2. `GITHUB_TOKEN` / `GH_TOKEN` 环境变量
3. 本机 `gh auth token`（推荐：`gh auth login` 一次）
4. 仓库已公开时直接匿名访问

都没有时，市场页显示授权引导；内置游戏不受影响。安装时下载 ROM + 封面、校验 SHA-256 后落盘。

## 数据目录

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/DSH Game Bench` |
| Windows | `%APPDATA%\DSH Game Bench` |
| Linux | `$XDG_DATA_HOME/dsh-game-bench` 或 `~/.local/share/dsh-game-bench` |

可用 `DSH_GAME_BENCH_DATA=/custom/path` 覆盖。内含 `catalog.json`、`store.json`、`roms/`、`covers/`、`library.json`、`settings.json`。
存档不在这里，而在浏览器 IndexedDB（库名 `game-bench`）。

## 结构

```
dsh-game-bench/
├── package.json              # manifest：bundle patch + dsh.client
├── cordis.patch.yml          # 插入 game-bench 一行插件
├── index.js                  # Host 入口：/game-bench/api/* 路由与生命周期
├── server/                   # 路径、鉴权、GitHub 传输、目录缓存、下载校验、库状态
├── engine.js                 # 模拟器封装：帧循环 / 渲染 / 音频 / 输入 / 存档 / 截图
├── vendor/jsnes.min.js       # jsnes 2.1.0（Apache-2.0，原样分发）
├── client.js                 # Web 面板：游戏库 / 市场 / 播放器 / 设置
├── locale/{zh,en}.json       # 插件标题与描述
├── assets/icon-256.png       # 插件图标
├── games/                    # 内置游戏（ROM + 封面 + builtin.json）
├── scripts/pack-builtins.mjs # 从自己的资源库生成内置清单
├── docs/{API,ENGINE,CONTRACT}.md
└── selftest/                 # 离线 harness + 真实 Host/页面验收
```

## 开发与验收

```sh
NODE=node   # 用 DSH 自带的 Node 24 亦可

node dsh-game-bench/server/selftest.mjs   # Host 接口（真实 GitHub：目录/下载/校验/安装/卸载/鉴权）
node dsh-game-bench/engine.selftest.mjs   # 模拟器（7 款 ROM × 959 帧、存档往返、崩溃恢复）
node dsh-game-bench/selftest/run.mjs      # 前端离线验收（headless Chrome + 真 React + 真 client/engine）
node dsh-game-bench/selftest/real-api.mjs # 真实 Host 路由验收（插件已安装时）
```

## 内置游戏与素材

- 本公开仓库**不包含任何受版权保护的游戏 ROM**。`games/` 只跟随作者的原创 demo
  **星光试航 Star Pilot**（`starpilot.nes`，由 `make_demo.py` 程序生成，可自由分发）。
- 想在自己的机器上内置经典游戏：从你有权使用的资源库生成私有清单
  （见 `BUILTIN-GAMES.md`），生成物被 `.gitignore` 排除，不会污染公开仓库。
- `vendor/jsnes.min.js`：jsnes 2.1.0，Apache-2.0（`vendor/LICENSE-jsnes.txt`），未修改。
- 市场目录与封面来自 `zeelinkCN/game-bench-library`，按其授权使用。

## 许可

MIT（`LICENSE`）。
