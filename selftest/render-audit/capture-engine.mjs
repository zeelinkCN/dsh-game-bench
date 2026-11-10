#!/usr/bin/env node
/**
 * 渲染诊断 · 把生产 engine.js 真身跑在 Node 假 canvas 里（同一个 vendor jsnes），
 * 逐帧截获 Renderer 写入的 ImageData，与「纯 jsnes onFrame buffer」做逐字节比较：
 *   - 验证 engine 的像素复制是否 1:1（有无颜色顺序/行距/偏移问题）
 *   - 验证 canvas 初始尺寸、putImageData 位置
 *
 * 产出：out/engine/<slot>/frame-<n>.raw（RGBA，来自 engine 实际 putImageData）
 *       out/engine/<slot>/manifest.json
 *       out/engine-compare.json（逐帧 engine-vs-pure 字节比较）
 *
 * 用法：node capture-engine.mjs [--only <slot>] [--frames 1000]
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.GAME_BENCH_PLUGIN_DIR || resolve(HERE, '..', '..')
const GAMES_DIR = join(PLUGIN, 'games')
const OUT = process.env.RENDER_AUDIT_OUT || join(HERE, 'out', 'engine')

const FRAME_W = 256
const FRAME_H = 240
const PIXELS = FRAME_W * FRAME_H
const FRAME_MS = 1000 / 60.098

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? String(process.argv[i + 1]) : ''
})()
const totalFrames = (() => {
  const i = process.argv.indexOf('--frames')
  return i >= 0 ? Number(process.argv[i + 1]) : 1000
})()

/* ------------------------------------------------------------------ *
 * 1) 加载 vendor jsnes（UMD）到本进程 globalThis
 * ------------------------------------------------------------------ */
const vendorCode = readFileSync(join(PLUGIN, 'vendor', 'jsnes.min.js'), 'utf8')
vm.runInThisContext(vendorCode, { filename: 'vendor/jsnes.min.js' })
const jsnes = globalThis.jsnes
if (!jsnes || typeof jsnes.NES !== 'function') throw new Error('vendor jsnes 加载失败')

/* ------------------------------------------------------------------ *
 * 2) 假浏览器 + 假 canvas，运行 engine.js
 * ------------------------------------------------------------------ */
function makeFakeCanvas() {
  const state = { puts: [], ctx: null, canvas: null }
  const ctx = {
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) }
    },
    putImageData(imageData, dx, dy) {
      state.puts.push({ dx, dy, data: Uint8ClampedArray.from(imageData.data) })
    },
    clearRect() {},
    fillRect() {},
    drawImage() {},
    save() {},
    restore() {},
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    },
  }
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext() {
      return ctx
    },
    toDataURL() {
      return ''
    },
  }
  state.ctx = ctx
  state.canvas = canvas
  return state
}

function createEngineRuntime() {
  const sandbox = {}
  const context = vm.createContext(sandbox)
  // engine 通过 `typeof window !== 'undefined' && window` 取 root
  vm.runInContext('globalThis.window = globalThis;', context)
  context.jsnes = jsnes
  context.console = console
  context.navigator = { userAgent: 'node-render-audit' }
  let nowMs = 0
  context.performance = { now: () => nowMs }
  let pendingFrame = null
  let rafId = 0
  context.requestAnimationFrame = (callback) => {
    pendingFrame = callback
    rafId += 1
    return rafId
  }
  context.cancelAnimationFrame = () => {
    pendingFrame = null
  }
  context.setTimeout = (fn) => 0
  context.clearTimeout = () => {}
  context.document = {
    createElement() {
      return makeFakeCanvas().canvas
    },
    addEventListener() {},
    removeEventListener() {},
  }

  vm.runInContext(readFileSync(join(PLUGIN, 'engine.js'), 'utf8'), context, { filename: 'engine.js' })
  if (!context.GameBenchCore || typeof context.GameBenchCore.create !== 'function') {
    throw new Error('engine.js 未暴露 GameBenchCore.create')
  }
  return {
    context,
    advance(ms) {
      nowMs += ms
      const callback = pendingFrame
      pendingFrame = null
      if (typeof callback === 'function') callback(nowMs)
    },
  }
}

/* ------------------------------------------------------------------ *
 * 3) 同一脚本驱动纯 jsnes 与 engine，逐帧截图对比
 * ------------------------------------------------------------------ */
const BUTTON = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 }
const defaultScript = [
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

const manifest = JSON.parse(readFileSync(join(GAMES_DIR, 'builtin.json'), 'utf8'))
const captureFrames = new Set([60, 120, 200, 320, 400, 500, 620, 760, 900, 990])
const results = []

for (const game of manifest.games) {
  if (only && !game.id.includes(only) && !game.title.includes(only)) continue
  const slot = `${game.id.slice(0, 11)}-${game.title.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}`
  const dir = join(OUT, slot)
  mkdirSync(dir, { recursive: true })
  const rom = new Uint8Array(readFileSync(join(GAMES_DIR, game.file)))

  /* ---- 纯 jsnes ---- */
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

  /* ---- engine ---- */
  const runtime = createEngineRuntime()
  const canvasState = makeFakeCanvas()
  const engine = runtime.context.GameBenchCore.create({
    canvas: canvasState.canvas,
    volume: 0.5,
    muted: true,
    speed: 1,
    onState() {},
    onError() {},
  })
  engine.loadRom(rom)
  engine.start()
  runtime.advance(0) // 让第一帧 rAF 回调登记

  const held = new Set()
  const applyInput = (action) => {
    const targets = []
    if (action.hold) {
      for (const name of [...held]) {
        if (!action.hold.includes(name)) {
          held.delete(name)
          targets.push([name, false])
        }
      }
      for (const name of action.hold) {
        if (!held.has(name)) {
          held.add(name)
          targets.push([name, true])
        }
      }
    }
    for (const [name, down] of targets) {
      pure.buttonDown(1, BUTTON[name])
      if (!down) pure.buttonUp(1, BUTTON[name])
      try {
        engine.setButton(name, down, 1)
      } catch (err) {
        /* ignore */
      }
    }
    for (const name of action.tap || []) {
      pure.buttonDown(1, BUTTON[name])
      pure.frame()
      pure.buttonUp(1, BUTTON[name])
      try {
        engine.setButton(name, true, 1)
        runtime.advance(FRAME_MS)
        engine.setButton(name, false, 1)
      } catch (err) {
        /* ignore */
      }
    }
  }

  const captures = []
  const pairs = []
  const pureHashes = []
  const engineHashes = []
  let putCount = 0
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const action = defaultScript.find((item) => item.at === frameIndex)
    if (action) applyInput(action)

    pure.frame()
    runtime.advance(FRAME_MS)
    runtime.advance(0) // 兼容 engine 因 catch-up 只跑一帧后重新登记 rAF

    const latestPut = canvasState.puts[canvasState.puts.length - 1]
    if (latestPut) putCount += 1
    if (captureFrames.has(frameIndex) && latestPut && pureFrame) {
      const rgba = Buffer.from(latestPut.data.buffer)
      const file = `frame-${String(frameIndex).padStart(4, '0')}.rgba`
      writeFileSync(join(dir, file), rgba)
      captures.push({ frame: frameIndex, file, dx: latestPut.dx, dy: latestPut.dy, sha256: createHash('sha256').update(rgba).digest('hex') })
    }
    if (pureFrame) {
      const expected = Buffer.alloc(PIXELS * 4)
      for (let i = 0; i < PIXELS; i += 1) {
        const value = pureFrame[i]
        const o = i * 4
        expected[o] = value & 0xff
        expected[o + 1] = (value >> 8) & 0xff
        expected[o + 2] = (value >> 16) & 0xff
        expected[o + 3] = 0xff
      }
      pureHashes.push(createHash('sha256').update(expected).digest('hex'))
      if (latestPut) {
        const engineHash = createHash('sha256').update(Buffer.from(latestPut.data.buffer)).digest('hex')
        engineHashes.push(engineHash)
        pairs.push({ frame: frameIndex, engineHash, expectedHash: pureHashes[pureHashes.length - 1] })
      }
    }
  }

  // 逐帧哈希对齐：engine 第 t 次 putImageData 是否等于纯 jsnes 第 t+d 帧
  const alignment = []
  for (let offset = -4; offset <= 4; offset += 1) {
    let equal = 0
    let compared = 0
    for (let t = 0; t < engineHashes.length; t += 1) {
      const idx = t + offset
      if (idx < 0 || idx >= pureHashes.length) continue
      compared += 1
      if (engineHashes[t] === pureHashes[idx]) equal += 1
    }
    alignment.push({ offset, equal, compared, percent: compared ? +((equal / compared) * 100).toFixed(3) : 0 })
  }
  // 每一帧在 ±4 帧窗口内是否至少有完全相同的纯 jsnes 帧（排除“像素被改过”）
  let matchedNearby = 0
  for (let t = 0; t < engineHashes.length; t += 1) {
    let found = false
    for (let d = -4; d <= 4; d += 1) {
      const idx = t + d
      if (idx >= 0 && idx < pureHashes.length && engineHashes[t] === pureHashes[idx]) {
        found = true
        break
      }
    }
    if (found) matchedNearby += 1
  }

  try {
    engine.destroy()
  } catch (err) {
    /* ignore */
  }

  const best = alignment.reduce((a, b) => (b.percent > a.percent ? b : a), alignment[0])
  const equalFrames = best.equal
  const matchedNearbyPercent = engineHashes.length ? +((matchedNearby / engineHashes.length) * 100).toFixed(3) : 0
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ slot, title: game.title, canvas: { width: canvasState.canvas.width, height: canvasState.canvas.height }, captures }, null, 2),
  )
  results.push({
    title: game.title,
    slot,
    framesCompared: best.compared,
    equalFrames,
    equalPercent: best.percent,
    bestOffset: best.offset,
    matchedNearbyPercent,
    alignment,
    puts: putCount,
    canvas: { width: canvasState.canvas.width, height: canvasState.canvas.height },
    putOrigin: captures[0] ? { dx: captures[0].dx, dy: captures[0].dy } : null,
  })
  console.log(
    `[engine] ${game.title.padEnd(16)} 最佳对齐 offset=${best.offset} 字节相等 ${equalFrames}/${best.compared} (${best.percent}%) ` +
      `±4帧窗口内可匹配 ${matchedNearbyPercent}% canvas=${canvasState.canvas.width}x${canvasState.canvas.height} putOrigin=${captures[0] ? captures[0].dx + ',' + captures[0].dy : '?'}`,
  )
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(results, null, 2))
writeFileSync(join(HERE, 'out', 'engine-compare.json'), JSON.stringify(results, null, 2))
console.log(`\n[engine] 结果 -> ${join(HERE, 'out', 'engine-compare.json')}`)
