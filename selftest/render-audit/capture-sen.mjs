#!/usr/bin/env node
/**
 * 渲染诊断 · 用 SEN（WASM，独立实现，作 ground truth）跑同一批 ROM/输入脚本，
 * 输出 out/sen/<slot>/frame-<n>.raw（Uint32LE，0x00BBGGRR，便于和 jsnes 逐字节比较）
 *
 * 用法：node capture-sen.mjs [--only <slot>]
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.GAME_BENCH_PLUGIN_DIR || resolve(HERE, '..', '..')
const GAMES_DIR = join(PLUGIN, 'games')
const OUT = process.env.RENDER_AUDIT_OUT || join(HERE, 'out', 'sen')
// RENDER_AUDIT_SEN_DIR 指向 @lukad/sen 包根目录（默认 ./node_modules/@lukad/sen）
const SEN_DIR = join(process.env.RENDER_AUDIT_SEN_DIR || join(HERE, 'node_modules', '@lukad', 'sen'), 'pkg')

const { default: initSen, Emulator } = await import(
  new URL(`file://${join(SEN_DIR, 'sen.js')}`).href
)
const wasmBytes = new Uint8Array(readFileSync(join(SEN_DIR, 'sen_bg.wasm')))
await initSen(wasmBytes)

const manifest = JSON.parse(readFileSync(join(GAMES_DIR, 'builtin.json'), 'utf8'))
const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? String(process.argv[i + 1]) : ''
})()

const BUTTON = { A: 1 << 0, B: 1 << 1, SELECT: 1 << 2, START: 1 << 3, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7 }
const maskOf = (buttons) => buttons.reduce((acc, b) => acc | BUTTON[b], 0)
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** SEN frameBuffer 是 RGBA；转 jsnes 的 Uint32LE 0x00BBGGRR 便于比较 */
function rgbaToNative(rgba) {
  const out = Buffer.alloc(256 * 240 * 4)
  for (let i = 0; i < 256 * 240; i += 1) {
    const o = i * 4
    const r = rgba[o]
    const g = rgba[o + 1]
    const b = rgba[o + 2]
    out.writeUInt32LE((0x00 << 24) | (b << 16) | (g << 8) | r, o)
  }
  return out
}

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
  { at: 999, hold: [] },
]
const totalFrames = 1000
const captureFrames = [60, 120, 200, 320, 400, 500, 620, 760, 900, 990]

const results = []
for (const game of manifest.games) {
  if (only && !game.id.includes(only) && !game.title.includes(only)) continue
  const slot = `${game.id.slice(0, 11)}-${game.title.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}`
  const dir = join(OUT, slot)
  mkdirSync(dir, { recursive: true })

  const rom = new Uint8Array(readFileSync(join(GAMES_DIR, game.file)))
  const emulator = new Emulator(rom, 48000)
  if (emulator.frameWidth() !== 256 || emulator.frameHeight() !== 240) {
    console.log(`[sen] 异常帧尺寸 ${emulator.frameWidth()}x${emulator.frameHeight()}（${game.title}）`)
  }

  const captures = []
  const pending = new Set(captureFrames)
  let holdMask = 0

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const action = defaultScript.find((item) => item.at === frameIndex)
    if (action) {
      if (action.hold) holdMask = maskOf(action.hold)
      if (action.tap) {
        for (const button of action.tap) {
          emulator.setController1(holdMask | BUTTON[button])
          emulator.runFrame()
          emulator.setController1(holdMask)
        }
      }
    }
    emulator.setController1(holdMask)
    emulator.runFrame()

    if (pending.has(frameIndex)) {
      const bytes = rgbaToNative(emulator.frameBuffer())
      const file = `frame-${String(frameIndex).padStart(4, '0')}.raw`
      writeFileSync(join(dir, file), bytes)
      captures.push({ frame: frameIndex, file, sha256: sha(bytes) })
      pending.delete(frameIndex)
    }
  }
  emulator.free()
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ slot, title: game.title, captures }, null, 2))
  results.push({ title: game.title, slot, captures: captures.length })
  console.log(`[sen] ${game.title} -> ${slot} (${captures.length} frames)`)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(results, null, 2))
console.log(`[sen] 完成 ${results.length} 款 -> ${OUT}`)
