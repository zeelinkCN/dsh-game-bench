#!/usr/bin/env node
/**
 * 渲染诊断 · Jackal（赤色要塞）密集帧对照
 *
 * 同一输入脚本下，jsnes 2.1.0（插件 vendor/jsnes.min.js 同字节）与独立实现 SEN 逐 30 帧采样，
 * 计算调色板无关的结构对齐指标：
 *   - 边缘图 IoU@(0,0) 与 ±8px 平移最优位移
 *   - 绿色精灵掩码 IoU@(0,0) 与 ±8px 平移最优位移
 * 目的：验证滚动/移动过程中，raw frameBuffer 是否存在 8px tile/精灵层间错位。
 *
 * 用法：node dense-jackal.mjs [--frames 1200] [--json out/dense-jackal.json]
 * SEN 依赖：RENDER_AUDIT_SEN_DIR 或 ./node_modules/@lukad/sen（仅测试用，不进发布依赖）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.GAME_BENCH_PLUGIN_DIR || resolve(HERE, '..', '..')
const OUT_DIR = process.env.RENDER_AUDIT_OUT || join(HERE, 'out')

const W = 256
const H = 240
const GAME_ID = 'nes-701f4d4da8db4566a12cfba194fc823990f808bea70a484b450ec0a6bba496a1'

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const totalFrames = Number(argValue('--frames', 1200))
const outFile = argValue('--json', join(OUT_DIR, 'dense-jackal.json'))

/* ---- 1) 加载 jsnes（插件 vendor 同字节） ---- */
const vendorCode = readFileSync(join(PLUGIN, 'vendor', 'jsnes.min.js'), 'utf8')
vm.runInThisContext(vendorCode, { filename: 'vendor/jsnes.min.js' })
const jsnes = globalThis.jsnes

/* ---- 2) 加载 SEN（独立实现，作 ground truth；仅测试） ---- */
const senDir =
  process.env.RENDER_AUDIT_SEN_DIR ||
  [join(HERE, 'node_modules', '@lukad', 'sen')].find(
    (dir) => existsSync(join(dir, 'pkg', 'sen.js')),
  )
if (!senDir) {
  console.error('缺少 @lukad/sen（仅测试用）。请先执行：pnpm add @lukad/sen@0.7.0（或设置 RENDER_AUDIT_SEN_DIR）')
  process.exit(2)
}
const { default: initSen, Emulator } = await import(new URL(`file://${join(senDir, 'pkg', 'sen.js')}`).href)
await initSen(new Uint8Array(readFileSync(join(senDir, 'pkg', 'sen_bg.wasm'))))

/* ---- 输入脚本（与 capture-pure/sen 一致；60fps 帧号语义） ---- */
const SCRIPT = [
  { at: 30, hold: [] },
  { at: 100, tap: ['START'] },
  { at: 180, tap: ['START'] },
  { at: 300, hold: ['RIGHT'] },
  { at: 330, tap: ['A'] },
  { at: 420, tap: ['A'] },
  { at: 520, hold: ['RIGHT'] },
  { at: 700, hold: ['RIGHT', 'A'] },
  { at: 900, hold: [] },
]
const MASK = { A: 1 << 0, B: 1 << 1, SELECT: 1 << 2, START: 1 << 3, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7 }
const BUTTON = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 }
const maskOf = (names) => names.reduce((acc, name) => acc | MASK[name], 0)

/* ---- 特征提取（调色板无关） ---- */
const toRGB = (raw) => {
  const rgb = new Uint8Array(W * H * 3)
  for (let i = 0; i < W * H; i += 1) {
    const v = raw.readUInt32LE(i * 4)
    rgb[i * 3] = v & 0xff
    rgb[i * 3 + 1] = (v >> 8) & 0xff
    rgb[i * 3 + 2] = (v >> 16) & 0xff
  }
  return rgb
}

const edgeMask = (rgb, threshold = 60) => {
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x
      const r = rgb[i * 3]
      const g = rgb[i * 3 + 1]
      const b = rgb[i * 3 + 2]
      if (x + 1 < W) {
        const j = i + 1
        if (Math.abs(r - rgb[j * 3]) + Math.abs(g - rgb[j * 3 + 1]) + Math.abs(b - rgb[j * 3 + 2]) > threshold) {
          mask[i] = 1
          continue
        }
      }
      if (y + 1 < H) {
        const j = i + W
        if (Math.abs(r - rgb[j * 3]) + Math.abs(g - rgb[j * 3 + 1]) + Math.abs(b - rgb[j * 3 + 2]) > threshold) mask[i] = 1
      }
    }
  }
  return mask
}

const greenMask = (rgb) => {
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i += 1) {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    mask[i] = g > 40 && g > r * 1.2 && g > b * 1.15 ? 1 : 0
  }
  return mask
}

const iouShift = (a, b, dx, dy) => {
  let inter = 0
  let union = 0
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const bx = x - dx
      const by = y - dy
      const bv = bx >= 0 && bx < W && by >= 0 && by < H ? b[by * W + bx] : 0
      const av = a[y * W + x]
      if (av && bv) inter += 1
      if (av || bv) union += 1
    }
  }
  return union ? inter / union : 0
}

const bestShift = (a, b) => {
  let best = { dx: 0, dy: 0, iou: iouShift(a, b, 0, 0) }
  for (const dy of [-8, 0, 8]) {
    for (const dx of [-8, 0, 8]) {
      const iou = iouShift(a, b, dx, dy)
      if (iou > best.iou + 1e-9) best = { dx, dy, iou }
    }
  }
  return best
}

/* ---- 双模拟器同步跑 ---- */
const rom = new Uint8Array(readFileSync(join(PLUGIN, 'games', `${GAME_ID}.nes`)))
const sampleEvery = 30
const samples = []
let pureFrame = null
const pure = new jsnes.NES({
  onFrame: (buffer) => {
    pureFrame = Uint32Array.from(buffer)
  },
  onAudioSample: null,
  emulateSound: false,
  sampleRate: 48000,
})
pure.loadROM(rom)
const sen = new Emulator(rom, 48000)
const held = new Set()

const capturePure = () => {
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i += 1) {
    const v = pureFrame[i]
    rgba[i * 4] = v & 0xff
    rgba[i * 4 + 1] = (v >> 8) & 0xff
    rgba[i * 4 + 2] = (v >> 16) & 0xff
    rgba[i * 4 + 3] = 0xff
  }
  return rgba
}

const captureSen = () => {
  const rgba = sen.frameBuffer()
  const native = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4
    native.writeUInt32LE((rgba[o + 2] << 16) | (rgba[o + 1] << 8) | rgba[o], o)
  }
  return native
}

let holdMask = 0
for (let frame = 0; frame < totalFrames; frame += 1) {
  const action = SCRIPT.find((item) => item.at === frame)
  if (action) {
    if (action.hold) {
      holdMask = maskOf(action.hold)
      for (const name of ['A', 'B', 'SELECT', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT']) {
        const down = action.hold.includes(name)
        if (down && !held.has(name)) {
          held.add(name)
          pure.buttonDown(1, BUTTON[name])
        } else if (!down && held.has(name)) {
          held.delete(name)
          pure.buttonUp(1, BUTTON[name])
        }
      }
    }
    for (const name of action.tap || []) {
      pure.buttonDown(1, BUTTON[name])
      pure.frame()
      pure.buttonUp(1, BUTTON[name])
      sen.setController1(holdMask | MASK[name])
      sen.runFrame()
      sen.setController1(holdMask)
    }
  }
  pure.frame()
  sen.runFrame()

  if (frame % sampleEvery === 0 && pureFrame) {
    const pRGB = toRGB(capturePure())
    const sRGB = toRGB(captureSen())
    const pEdge = edgeMask(pRGB)
    const sEdge = edgeMask(sRGB)
    const pGreen = greenMask(pRGB)
    const sGreen = greenMask(sRGB)
    const edgeBest = bestShift(pEdge, sEdge)
    const greenBest = bestShift(pGreen, sGreen)
    samples.push({
      frame,
      edge: { iou0: +iouShift(pEdge, sEdge, 0, 0).toFixed(4), best: { ...edgeBest, iou: +edgeBest.iou.toFixed(4) } },
      green: { iou0: +iouShift(pGreen, sGreen, 0, 0).toFixed(4), best: { ...greenBest, iou: +greenBest.iou.toFixed(4) } },
    })
  }
}
sen.free()

// 跨模拟器“可比帧”判定：结构 IoU 足够高才认为两边停在同一个逻辑画面；
// 低 IoU 是 CPU/PPU 时序模型差异导致的状态漂移（SEN 周期精确 vs jsnes 近似），不能当作渲染差异。
const COMPARABLE_IOU = 0.9
const comparable = samples.filter((s) => s.edge.best.iou >= COMPARABLE_IOU)
const drift = samples.filter((s) => s.edge.best.iou < COMPARABLE_IOU)
const edgeIous = comparable.map((s) => s.edge.iou0)
const greenIous = comparable.map((s) => s.green.iou0).filter((v) => v > 0.05)
const nonZeroShift = comparable.filter((s) => !(s.edge.best.dx === 0 && s.edge.best.dy === 0))
const summary = {
  game: '赤色要塞 (Jackal, mapper 2)',
  sampledFrames: samples.length,
  range: [samples[0]?.frame, samples[samples.length - 1]?.frame],
  comparableFrames: comparable.length,
  comparableFrameList: comparable.map((s) => s.frame),
  driftFrames: drift.map((s) => ({ frame: s.frame, edgeBestIoU: s.edge.best.iou })),
  comparableEdgeIoU0: edgeIous.length
    ? {
        min: +Math.min(...edgeIous).toFixed(4),
        mean: +(edgeIous.reduce((a, b) => a + b, 0) / edgeIous.length).toFixed(4),
        max: +Math.max(...edgeIous).toFixed(4),
      }
    : null,
  comparableGreenIoU0: greenIous.length
    ? {
        min: +Math.min(...greenIous).toFixed(4),
        mean: +(greenIous.reduce((a, b) => a + b, 0) / greenIous.length).toFixed(4),
        max: +Math.max(...greenIous).toFixed(4),
        framesWithSprites: greenIous.length,
      }
    : null,
  comparableBestShiftNotZero: nonZeroShift.length,
  bestShiftDistribution: samples.reduce((acc, s) => {
    const key = `${s.edge.best.dx},${s.edge.best.dy}`
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {}),
  samples,
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(summary, null, 2))
console.log(
  `[dense-jackal] 采样 ${summary.sampledFrames} 帧（${summary.range[0]}-${summary.range[1]}），可比帧 ${summary.comparableFrames}：` +
    (summary.comparableEdgeIoU0
      ? ` 边缘 IoU@0 min=${summary.comparableEdgeIoU0.min} mean=${summary.comparableEdgeIoU0.mean}`
      : ' 无可比帧') +
    (summary.comparableGreenIoU0 ? ` 绿色掩码 IoU@0 mean=${summary.comparableGreenIoU0.mean}` : '') +
    `，可比帧中最佳位移非(0,0) = ${summary.comparableBestShiftNotZero}` +
    `，状态漂移不可比帧 = ${summary.driftFrames.length}`,
)
console.log(`[dense-jackal] -> ${outFile}`)
