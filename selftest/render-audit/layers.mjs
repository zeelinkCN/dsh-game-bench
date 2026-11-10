#!/usr/bin/env node
/**
 * 渲染诊断 · 精灵层 / 背景层分离（jsnes 内部缓冲）
 *
 * jsnes 的 PPU 在渲染时维护：
 *   ppu.buffer       最终合成帧（Uint32 0x00BBGGRR）
 *   ppu.bgbuffer     背景层像素
 *   ppu.pixrendered  位标记：bit8(0x100)=该像素有背景；低 8 位=精灵优先级序号(0-7)
 *   ppu.scanlineSecondaryOAM / scanlineSpriteCount  每条扫描线进入渲染的精灵（OAM 字节）
 *
 * 分离后验证：
 *  1) 精灵层每个像素的 x 是否都落在该扫描线精灵的 [sprX, sprX+7] 区间内
 *     （若 jsnes 精灵层整体偏 8px，会出现大量“越界像素”）
 *  2) 背景层像素是否连续覆盖可见区域（无明显 8px 空洞）
 *  3) 输出 composite / bg-only / sprite-only 三张 raw（供 PNG 目视）
 *
 * 用法：node layers.mjs [--frame 620] [--out-dir out/layers]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.GAME_BENCH_PLUGIN_DIR || resolve(HERE, '..', '..')
const OUT_DIR = process.env.RENDER_AUDIT_OUT || join(HERE, 'out')

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const TARGET_FRAME = Number(argValue('--frame', 620))
const outDir = argValue('--out-dir', join(OUT_DIR, 'layers'))
const W = 256
const H = 240
const GAME_ID = 'nes-701f4d4da8db4566a12cfba194fc823990f808bea70a484b450ec0a6bba496a1'

const vendorCode = readFileSync(join(PLUGIN, 'vendor', 'jsnes.min.js'), 'utf8')
vm.runInThisContext(vendorCode, { filename: 'vendor/jsnes.min.js' })
const jsnes = globalThis.jsnes

const BUTTON = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 }
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

let currentFrame = null
const rom = new Uint8Array(readFileSync(join(PLUGIN, 'games', `${GAME_ID}.nes`)))
const nes = new jsnes.NES({
  onFrame: (buffer) => {
    currentFrame = Uint32Array.from(buffer)
  },
  onAudioSample: null,
  emulateSound: false,
  sampleRate: 48000,
})
nes.loadROM(rom)

const held = new Set()
for (let frame = 0; frame <= TARGET_FRAME; frame += 1) {
  const action = SCRIPT.find((item) => item.at === frame)
  if (action) {
    if (action.hold) {
      for (const name of [...held]) {
        if (!action.hold.includes(name)) {
          held.delete(name)
          nes.buttonUp(1, BUTTON[name])
        }
      }
      for (const name of action.hold) {
        if (!held.has(name)) {
          held.add(name)
          nes.buttonDown(1, BUTTON[name])
        }
      }
    }
    for (const name of action.tap || []) {
      nes.buttonDown(1, BUTTON[name])
      nes.frame()
      nes.buttonUp(1, BUTTON[name])
    }
  }
  nes.frame()
}

const ppu = nes.ppu
const composite = currentFrame
const bgLayer = new Uint32Array(W * H)
const spriteLayer = new Uint32Array(W * H)
let bgPixels = 0
let spritePixels = 0
let spriteVisiblePixels = 0

for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const i = y * W + x
    const pri = ppu.pixrendered[i]
    const hasBg = (pri & 0x100) !== 0
    const hasSprite = (pri & 0xff) < 8
    if (hasBg) {
      bgLayer[i] = ppu.bgbuffer[i]
      bgPixels += 1
    }
    if (hasSprite) {
      spriteLayer[i] = composite[i]
      spritePixels += 1
      if (!hasBg) spriteVisiblePixels += 1
    }
  }
}

/* ---- 校验 1：精灵层 x 是否都在该扫描线精灵区间内 ---- */
const violations = []
for (let y = 0; y < H; y += 1) {
  const count = ppu.scanlineSpriteCount[y]
  const intervals = []
  for (let s = 0; s < count; s += 1) {
    const base = y * 32 + s * 4
    const sprX = ppu.scanlineSecondaryOAM[base + 3]
    intervals.push([sprX, sprX + 7])
  }
  for (let x = 0; x < W; x += 1) {
    const i = y * W + x
    if ((ppu.pixrendered[i] & 0xff) >= 8) continue
    if (!intervals.some(([x0, x1]) => x >= x0 && x <= x1)) {
      violations.push({ x, y })
    }
  }
}

/* ---- 校验 2：背景层可见区域连续性（每行 bg 像素最大 x 与计数） ---- */
let bgRowGaps = 0
for (let y = 0; y < H; y += 1) {
  let minX = -1
  let maxX = -1
  let count = 0
  for (let x = 0; x < W; x += 1) {
    if ((ppu.pixrendered[y * W + x] & 0x100) === 0) continue
    count += 1
    if (minX < 0) minX = x
    maxX = x
  }
  if (count > 0 && maxX - minX + 1 !== count) bgRowGaps += 1
}

/* ---- 输出 raw（Uint32LE 0x00BBGGRR） ---- */
mkdirSync(outDir, { recursive: true })
const writeRaw = (name, u32) => {
  const buffer = Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength)
  writeFileSync(join(outDir, name), buffer)
}
writeRaw(`frame-${TARGET_FRAME}-composite.raw`, composite)
writeRaw(`frame-${TARGET_FRAME}-bg.raw`, bgLayer)
writeRaw(`frame-${TARGET_FRAME}-sprite.raw`, spriteLayer)

const summary = {
  game: '赤色要塞 (Jackal, mapper 2)',
  frame: TARGET_FRAME,
  pixels: { total: W * H, bg: bgPixels, sprite: spritePixels, spriteVisibleOverBgTransparent: spriteVisiblePixels },
  spriteOam: {
    evaluationNote: 'per-scanline secondary OAM（jsnes 2.1.0 逐行精灵评估结果）',
    maxSpritesPerScanline: Math.max(...Array.from(ppu.scanlineSpriteCount)),
    scanlinesWithSprites: Array.from(ppu.scanlineSpriteCount).filter((n) => n > 0).length,
  },
  checks: {
    spritePixelsOutsideOamIntervals: violations.length,
    spriteViolationSamples: violations.slice(0, 10),
    // 背景层“非透明像素不连续行数”——透明色(索引0)本来就不写 pixrendered，属预期，不作 bug 指标
    bgRowsWithTransparentHoles: bgRowGaps,
  },
  outDir,
}
writeFileSync(join(outDir, 'layers-report.json'), JSON.stringify(summary, null, 2))
console.log(
  `[layers] frame ${TARGET_FRAME}: bg=${bgPixels}px sprite=${spritePixels}px ` +
    `每扫描线最多精灵=${summary.spriteOam.maxSpritesPerScanline} ` +
    `精灵越界像素=${violations.length} 背景行空洞=${bgRowGaps}`,
)
console.log(`[layers] -> ${outDir}`)
