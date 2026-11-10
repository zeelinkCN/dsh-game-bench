#!/usr/bin/env node
/**
 * 渲染诊断 · 直接跑 jsnes 2.1.0（npm 包 src，与 vendor/jsnes.min.js 同版本同字节）
 *
 * 产出：out/pure/<slot>/frame-<n>.raw（Uint32LE，jsnes 原生 0x00BBGGRR）
 *       out/pure/<slot>/manifest.json（每帧 sha256、帧号、mapper、动作）
 *
 * 用法：node capture-pure.mjs [--only <slot>] [--frames a,b,c]
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.GAME_BENCH_PLUGIN_DIR || resolve(HERE, '..', '..')
const GAMES_DIR = join(PLUGIN, 'games')
const OUT = process.env.RENDER_AUDIT_OUT || join(HERE, 'out', 'pure')

// 直接用插件 vendor/jsnes.min.js（UMD，与 npm jsnes@2.1.0 dist 字节一致）
vm.runInThisContext(readFileSync(join(PLUGIN, 'vendor', 'jsnes.min.js'), 'utf8'), {
  filename: 'vendor/jsnes.min.js',
})
const jsnes = globalThis.jsnes
if (!jsnes || typeof jsnes.NES !== 'function') throw new Error('vendor jsnes 加载失败')

const manifest = JSON.parse(readFileSync(join(GAMES_DIR, 'builtin.json'), 'utf8'))
const want = (argv) => {
  const i = argv.indexOf('--only')
  return i >= 0 ? String(argv[i + 1]) : ''
}
const only = want(process.argv.slice(2))

/** 从 ROM 头解析 mapper / PRG / CHR */
function romInfo(bytes) {
  const h = bytes.subarray(0, 16)
  return {
    mapper: ((h[6] >> 4) & 0xf) | (h[7] & 0xf0),
    prgKB: h[4] * 16,
    chrKB: h[5] * 8,
    mirroring: h[6] & 1 ? 'vertical' : 'horizontal',
    size: bytes.length,
  }
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 单帧原始 Uint32 转 LE buffer */
const rawOf = (frame) => Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)

/**
 * 跑一款游戏，按动作脚本推进帧并在指定帧存 raw。
 * 动作脚本：[{ at: 帧号, hold?: [buttons], tap?: [buttons] }]，hold 持续到下一个 hold 指令。
 */
function runGame(slot, title, romBytes, actions, captureFrames, totalFrames) {
  const dir = join(OUT, slot)
  mkdirSync(dir, { recursive: true })

  let current = null
  const nes = new jsnes.NES({
    onFrame: (buffer) => {
      // buffer 是每帧复用的 Uint32Array(256*240)，截获时复制一份
      current = Uint32Array.from(buffer)
    },
    onAudioSample: null,
    emulateSound: false,
    sampleRate: 48000,
  })
  nes.loadROM(romBytes)

  const captures = []
  const pending = new Map(captureFrames.map((n) => [n, true]))
  const held = new Set()

  const applyButtons = (spec) => {
    if (spec.hold) {
      for (const button of [...held]) {
        if (!spec.hold.includes(button)) {
          nes.buttonUp(1, button)
          held.delete(button)
        }
      }
      for (const button of spec.hold) {
        if (!held.has(button)) {
          nes.buttonDown(1, button)
          held.add(button)
        }
      }
    }
    for (const button of spec.tap || []) {
      nes.buttonDown(1, button)
      nes.frame()
      nes.buttonUp(1, button)
    }
  }

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const action = actions.find((item) => item.at === frameIndex)
    if (action) applyButtons(action)
    nes.frame()
    if (current && pending.has(frameIndex)) {
      const bytes = rawOf(current)
      const file = `frame-${String(frameIndex).padStart(4, '0')}.raw`
      writeFileSync(join(dir, file), bytes)
      captures.push({ frame: frameIndex, file, sha256: sha(bytes) })
      pending.delete(frameIndex)
    }
  }

  // 释放所有按键
  for (const button of held) nes.buttonUp(1, button)

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ slot, title, rom: romInfo(romBytes), captures }, null, 2),
  )
  return captures
}

const BUTTON = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 }

/** 动作脚本：先等标题，按 START，再向右走 + 开火，检查游戏内画面 */
const defaultScript = (total) => [
  { at: 30, hold: [] },
  { at: 100, tap: [BUTTON.START] },
  { at: 180, tap: [BUTTON.START] },
  { at: 300, hold: [BUTTON.RIGHT] },
  { at: 330, tap: [BUTTON.A] },
  { at: 420, tap: [BUTTON.A] },
  { at: 520, hold: [BUTTON.RIGHT] },
  { at: 700, hold: [BUTTON.RIGHT, BUTTON.A] },
  { at: 900, hold: [] },
  { at: total - 1, hold: [] },
]

const totalFrames = 1000
const captureFrames = [60, 120, 200, 320, 400, 500, 620, 760, 900, 990]

const results = []
for (const game of manifest.games) {
  if (only && !game.id.includes(only) && game.title !== only) continue
  const bytes = new Uint8Array(readFileSync(join(GAMES_DIR, game.file)))
  const slot = `${game.id.slice(0, 11)}-${game.title.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}`
  const captures = runGame(slot, game.title, bytes, defaultScript(totalFrames), captureFrames, totalFrames)
  results.push({ title: game.title, slot, mapper: romInfo(bytes).mapper, captures: captures.length })
  console.log(`[pure] ${game.title} (mapper ${romInfo(bytes).mapper}) -> ${slot} (${captures.length} frames)`)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(results, null, 2))
console.log(`[pure] 完成 ${results.length} 款 -> ${OUT}`)
