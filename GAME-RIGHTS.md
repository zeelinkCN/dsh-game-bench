# 内置游戏的权利声明（Repository owner's rights attestation）

本仓库 `games/` 下的 7 款经典红白机游戏 ROM 与封面，**不是本 MIT 许可的覆盖对象**，
也不是作者自行生成的内容。它们是第三方发行公司的版权作品，本仓库收录它们基于
**仓库所有者（zeelinkCN）的如下声明**：

> 仓库所有者声明：已就以下游戏取得各发行公司的再分发许可并已付费，
> 因此授权将它们收录进本公开仓库，随插件分发。

| 游戏 | 原始发行 | 目录 id |
| --- | --- | --- |
| 超级玛丽1（Super Mario Bros.） | Nintendo | `nes-ec299b99…` |
| 魂斗罗（Contra，汉化版） | Konami | `nes-69084b4f…` |
| 赤色要塞（Jackal） | Konami | `nes-701f4d4d…` |
| 雪人兄弟（Snow Bros.，汉化版） | Toaplan | `nes-1a4d476a…` |
| 坦克大战（Battle City，汉化版） | Namco | `nes-8c556ef6…` |
| 松鼠大作战（Chip 'n Dale，汉化版） | Capcom | `nes-b903a970…` |
| 双截龙2 复仇（Double Dragon II，汉化版） | Technos Japan | `nes-02ade1c3…` |

## 说明

- **这些 ROM 的使用条款以各发行公司授予仓库所有者的许可为准**，不适用本仓库的 MIT 许可。
  任何第三方使用、复制或再分发这些游戏文件之前，应自行确认已获得相应权利人的许可。
- 若你是权利人，认为上述收录超出了授权范围，请通过 issue 或邮件联系仓库所有者，
  我们会立即移除对应文件。
- 原创 demo `games/starpilot.nes`（星光试航 Star Pilot）由仓库作者自行生成，可随 MIT 许可分发。
- 游戏市场内容（`zeelinkCN/game-bench-library`）不在本仓库范围内。

## 技术说明

- ROM 字节与资源库 `owned/<sha256>.nes` 完全一致，`games/builtin.json` 记录每款的
  `sha256` 与 `size`，可逐字节校验。
- 插件代码（`index.js` / `server/` / `engine.js` / `client.js`）与 jsnes 运行时
  （`vendor/jsnes.min.js`，Apache-2.0）与本声明无关，仍按各自的许可分发。
