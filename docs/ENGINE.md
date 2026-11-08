# 模拟器运行时契约（engine.js / vendor/jsnes.min.js）

`engine.js` 是挂在 `window` 上的自包含 IIFE（不 import 任何模块），由 Host 以 `/game-bench/api/engine.js` 提供；
`client.js` 负责先加载 `/game-bench/api/vendor/jsnes.js`（UMD → `window.jsnes`），再加载 `engine.js`。
两者都加载成功后，`window.GameBenchCore` 才可用。

## 1. 依赖与边界

- jsnes 2.1.0（Apache-2.0），UMD 全局 `jsnes`，只使用 `jsnes.NES`。
- `engine.js` **不绑定任何 document 级键盘事件、不创建 DOM 元素、不改页面样式**（音频解锁所需的用户手势监听除外，且必须可清理）。
- 键盘/手柄的“谁在按键”由 `client.js` 决定，然后调 `setButton`；这样切到对话输入框时不会抢键。
- 渲染由 engine 直接写 `canvas.getContext('2d')` 的 ImageData，不走 React 状态，**不得每帧 setState**。
- 帧循环用 `requestAnimationFrame` + 时间累加器，目标 60.098 fps；面板不可见/暂停时停止累加。

## 2. 工厂

```js
const engine = window.GameBenchCore.create({
  canvas: HTMLCanvasElement,     // 必填；engine 把 width/height 固定为 256/240
  volume: 0.8,                   // 0..1
  muted: false,
  speed: 1,                      // 0.5 | 1 | 2（倍速）
  onState(state) {},             // 状态变化回调（低频，不是每帧）
  onError(error) {},             // 运行期异常（崩溃、音频失败等）
})
```

`onState` 的 payload（每次变化才回调）：

```js
{
  running: boolean,      // 是否在跑帧循环
  paused: boolean,
  crashed: boolean,
  audio: 'off' | 'starting' | 'on' | 'blocked' | 'unsupported',
  fps: number,           // 最近 1s 实测
  frames: number,        // 累计帧数
  romTitle: string       // 从 ROM 头推断不出时为 ''
}
```

## 3. 方法

| 方法 | 说明 |
|---|---|
| `loadRom(uint8Array)` | 同步加载并 reset；非法 ROM 抛 `Error`，`error.code = 'BAD_ROM'` |
| `start()` | 开始帧循环（首次调用会尝试启动音频） |
| `pause()` / `resume()` / `togglePause()` | 暂停时不消耗帧、不推进音频 |
| `reset()` | 软复位（jsnes `reset()`），保留已加载 ROM |
| `setButton(name, down, player = 1)` | `name ∈ A,B,UP,DOWN,LEFT,RIGHT,START,SELECT`；幂等 |
| `releaseAll()` | 松开所有按键（切面板/失焦时调用） |
| `setVolume(v)` / `setMuted(bool)` / `setSpeed(mult)` | 音频增益、静音、0.5/1/2 倍速（`setSpeed` 可接受任意 0.25~3） |
| `saveState()` → `Promise<Uint8Array>` | 返回 **gzip 压缩的 UTF-8 JSON**（`jsnes.toJSON()`）；无 `CompressionStream` 时返回未压缩 JSON 字节 |
| `loadState(uint8Array)` → `Promise<void>` | 自动识别 gzip（`1f 8b`）或裸 JSON；失败抛错 |
| `snapshot()` → `string` | 当前画面 PNG dataURL（256×240 原始像素） |
| `destroy()` | 停止循环、断开音频、移除监听；之后不可再用 |

约定：
- `saveState` 产物体积：实测 7 款内置游戏 `JSON.stringify(toJSON())` 在 0.96–1.56 MB，gzip 后应 < 250 KB。
- `loadState` 前必须有 ROM；`loadState` 内部先 `reset()` 再由 `fromJSON` 覆盖。
- 音频：AudioWorklet（内联 Blob URL 的 processor），48 kHz 立体声，ring buffer ≈ 170 ms；`AudioContext` 被自动播放策略挡住时 `audio:'blocked'`，并在下一次用户手势（pointerdown/keydown）时自动 `resume()`。
- 采样率：用 `AudioContext.sampleRate` 传给 `new jsnes.NES({ sampleRate })`。
- 崩溃（`nes.crashed` 或 frame 抛错）：清 `crashed: true`，停止循环，`onError` 上报，保留 ROM 供 `reset()` 重来。

## 4. 渲染细节（已核实）

- `new jsnes.NES({ onFrame, onAudioSample, sampleRate })`；`onFrame` 收到的 `buffer` 是 `Uint32Array(256*240)`，像素值为 `0x00BBGGRR`。
- 画到 canvas：`ImageData.data32[i] = 0xff000000 | buffer[i]`，`putImageData`，尺寸 256×240。
- CSS 缩放（整数倍像素、适应容器）由 `client.js` 负责，engine 不改 canvas 的 style 尺寸（只保证内部分辨率）。
- 需要在 canvas 上开启 `image-rendering: pixelated`（由 client.js 的 CSS 设置）。

## 5. 帧循环要求

- 使用 `requestAnimationFrame`，按“实际经过时间 / (1000/60.098/speed)”生成帧，单帧最多补 4 帧，防止卡顿后暴走。
- 每帧后把累积音频样本刷给 worklet（`flush` 语义）。
- `pause()` 后 `rAF` 停止调度；`resume()` 重置时间基准，避免补帧雪崩。
- 页面 `document.hidden` 时由 client 调 `pause()`；engine 不自行处理（保持可控）。

## 6. 验收（engine 自测脚本必须覆盖）

`selftest/engine-node.mjs` 或 `engine-selftest.html` 至少验证：

1. 加载 7 款内置 ROM（`games/*.nes`）各跑 600 帧不抛错，且画面非全黑（非 0 像素数 > 500）。
2. `saveState()` → `loadState()` 往返后继续跑 120 帧不抛错，且状态字节长度 > 1000。
3. `setButton('START', true)` 后帧推进不抛错；`releaseAll()` 后无卡键。
4. `destroy()` 后 rAF 停止（无残留帧增长）。
5. 性能：单帧平均耗时 < 8 ms（本机实测 jsnes 约 0.6–0.9 ms/帧，含渲染应 < 4 ms）。

## 7. 依赖文件

- `vendor/jsnes.min.js`：`https://registry.npmjs.org/jsnes/-/jsnes-2.1.0.tgz` 中的 `dist/jsnes.min.js`，**不要修改**，随包保留 `vendor/LICENSE-jsnes.txt`（Apache-2.0 全文）。
- License 头：`engine.js` 顶部注释注明「依赖 jsnes 2.1.0 (Apache-2.0, https://github.com/bfirsh/jsnes)」。

## 8. 实现备注（engine 1.0.0，非契约变更，供集成参考）

以下是 `engine.js` 在契约之上的实现细节，**不改变第 2–6 节的约定**：

- `reset()`：jsnes 2.1.0 的 `NES.reset()` 只重建 CPU/PPU/PAPU/mapper 实例，却不会再执行
  `mapper.loadROM()`，直接调用后下一帧会 `invalid opcode` 崩溃（上游缺陷）。engine 保留
  `loadRom` 传入的 ROM 字节，用「重新 `nes.loadROM(romData)`」实现等价软复位——RAM/PPU/CPU
  全部重置、已加载 ROM 不丢。
- `running`：`start()` 之后、未暂停/未崩溃/未销毁时为 `true`；暂停时 `running:false, paused:true`；
  崩溃时 `running:false, crashed:true`。
- `frames`：当前 ROM 的累计仿真帧数（`loadRom` 归零，`reset()` 不清零）。
- `audio` 初始为 `'off'`。`create()` 时会先建立 `AudioContext`（suspended 也允许），以便把
  `AudioContext.sampleRate` 传给 jsnes；`start()` 后若被自动播放策略挡住为 `'blocked'`，
  首次 `pointerdown`/`keydown` 自动 `resume()` 并变 `'on'`。
- 无 `AudioContext` → `audio:'unsupported'` 且完全静音（不触发 `onError`）；有 `AudioContext`
  但 AudioWorklet 失败 → 回退 ScriptProcessor；两者都不可用 → `unsupported`。
- 倍速（`speed ≠ 1`）时对音频样本做最近邻重采样，只保证「大致实时」，非高保真。
- `snapshot()` 在无 DOM 环境返回 `''`。
- `loadRom` 接受 `Uint8Array`/`ArrayBuffer`/二进制字符串；`setButton` 额外接受
  `TURBO_A`/`TURBO_B`（jsnes 2.1.0 内置），未知按键名静默忽略（仅 debug 模式打日志）。
- `start()` 在尚未 `loadRom` 时返回 `false` 并记住意图，`loadRom` 完成后自动开跑。
- `start()` 会同步执行并渲染首帧（点击「开始」后画面立刻出现，且首次 `onState` 即
  `frames=1`），随后才交给 rAF 循环；崩溃会在首帧同步上报并按崩溃流程处理。
- `destroy()` 幂等；销毁后控制方法安全 no-op，`loadRom`/`saveState`/`loadState` 抛 `DESTROYED`。
- 自测脚本：`engine.selftest.mjs`（Node 全路径运行；含最小 DOM 垫片 + mock WebAudio，
  覆盖 7 款内置 ROM、存档往返、崩溃/reset、AudioWorklet 与 ScriptProcessor 两条音频路径）。
