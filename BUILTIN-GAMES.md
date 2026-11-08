# 内置游戏：公开部分与本机私有部分

## 公开仓库只带一个 demo

`games/starpilot.nes`（**星光试航 / Star Pilot**）是插件作者自己用程序生成的 NES demo
（源码见作者另一仓库：`Resources/Demo/StarPilot.nes` 由 `scripts/make_demo.py` 产出），
可以随 MIT 插件自由分发。它出现在 `games/builtin.json` 里：

```json
{ "id": "starpilot", "title": "星光试航 Star Pilot", "file": "starpilot.nes", "cover": "starpilot.png", ... }
```

## 本机私有内置游戏（不入库）

插件所有者本人另有 7 款经典游戏（超级玛丽、魂斗罗、赤色要塞、雪人兄弟、坦克大战、
松鼠大作战、双截龙2），来自其**明确授权的私有备份库** `zeelinkCN/game-bench-library`
（`sources.json` 记录原始来源仓库与提交，`catalog.json` 记录每款 SHA-256）。

它们以如下形式存在，并且**全部被 `.gitignore` 排除**：

| 文件 | 说明 |
| --- | --- |
| `games/builtin.local.json` | 私有内置清单（7 条），同样字段结构 |
| `games/nes-<sha256>.nes` | ROM，字节与资源库 `owned/<sha256>.nes` 一致 |
| `games/nes-<sha256>.png` | 封面，取自资源库 `covers/` 或 `legacy-images/` |

Host 侧会读取 `builtin.json` + `builtin.local.json` 两份清单并合并；条目对应的
ROM/封面文件不存在时会被静默跳过（所以干净 clone 下只有 demo，不会报错）。

## 如何在自己的机器上生成私有内置清单

```sh
GAMEBENCH_LIBRARY_DIR=/path/to/game-bench-library \
  node dsh-game-bench/scripts/pack-builtins.mjs --force
```

脚本按 `catalog.json` 的 `featuredRank` 取前 N 款（默认 7），把 ROM/封面拷进 `games/`
并写 `games/builtin.local.json`。资源库更新后重跑即可；已知 7 个 SHA-256 白名单在脚本里，
避免资源库更新后静默换游戏。

## 分发限制（重要）

这些经典 ROM 是**受版权保护的游戏备份**，只能安装在所有者本人使用的机器上。
公开这个插件（GitHub / npm / 应用市场）时**必须**保持它们不被跟踪：

- `.gitignore` 已经排除 `games/nes-*` 与 `games/builtin.local.json`，不要用 `git add -f` 绕过；
- 不要把 `games/*.png` 里的游戏封面、或 `selftest/shots/` 里的游戏画面截图公开；
- 插件代码（MIT）与 jsnes 运行时（Apache-2.0）不受限制；
- demo `starpilot.*` 是作者原创，可以公开。
