# 内置游戏

`games/` 随插件分发 **8 款**游戏，断网可玩：

| # | 游戏 | 文件 | 说明 |
| --- | --- | --- | --- |
| 1 | 超级玛丽1 | `nes-ec299b99….nes` | 第三方版权作品 |
| 2 | 魂斗罗（汉化） | `nes-69084b4f….nes` | 第三方版权作品 |
| 3 | 赤色要塞 | `nes-701f4d4d….nes` | 第三方版权作品 |
| 4 | 雪人兄弟（汉化） | `nes-1a4d476a….nes` | 第三方版权作品 |
| 5 | 坦克大战（汉化） | `nes-8c556ef6….nes` | 第三方版权作品 |
| 6 | 松鼠大作战（汉化） | `nes-b903a970….nes` | 第三方版权作品 |
| 7 | 双截龙2 复仇（汉化） | `nes-02ade1c3….nes` | 第三方版权作品 |
| 8 | 星光试航 Star Pilot | `starpilot.nes` | 作者原创 demo（MIT 覆盖） |

## 授权

前 7 款是各发行公司的版权作品，**不由本仓库的 MIT 许可覆盖**。收录依据是仓库所有者
已取得各发行公司再分发许可并已付费的声明；声明全文、发行公司对照与联系/移除渠道见
**`GAME-RIGHTS.md`**。任何第三方在再分发这些游戏文件前，必须自行取得权利人许可。

## 清单格式

`games/builtin.json`（v2）：

```json
{
  "version": 2,
  "games": [
    {
      "id": "nes-<sha256>",
      "title": "超级玛丽1",
      "file": "nes-<sha256>.nes",
      "cover": "nes-<sha256>.png",
      "sha256": "<sha256>",
      "size": 40976,
      "source": "https://github.com/…",
      "sourceNames": ["超级玛丽1"],
      "author": "用户授权备份",
      "language": "",
      "series": "",
      "distribution": "…",
      "featuredRank": 1
    }
  ]
}
```

Host 侧还会读取可选的 `games/builtin.local.json`（`.gitignore` 排除，用于本机追加），
两份清单按 `id` 合并；文件缺失的条目会被静默跳过。

## 校验

每款的 `sha256` 与 `size` 都可逐字节校验，且与资源库 `owned/<sha256>.nes` 一致：

```sh
shasum -a 256 games/*.nes
```

## 追加自己的游戏

```sh
GAMEBENCH_LIBRARY_DIR=/path/to/game-bench-library \
  node dsh-game-bench/scripts/pack-builtins.mjs --force
```

脚本按资源库 `catalog.json` 的 `featuredRank` 取前 N 款，拷 ROM/封面到 `games/` 并写
`games/builtin.local.json`（本机追加，不入库）。要公开新增游戏，请把它们并入
`games/builtin.json` 并同步更新 `GAME-RIGHTS.md`。
