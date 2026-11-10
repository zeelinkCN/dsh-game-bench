#!/usr/bin/env node
/**
 * 渲染诊断 · 结构对齐分析（跨模拟器，规避两边调色板差异）
 *
 * 思路：jsnes 与 SEN 各自输出 RGB 像素，调色板数值不同无法逐字节比较；
 * 但两边的“形状/位置”应当一致。这里用两种调色板无关特征：
 *   1) 绿色精灵掩码（Jackal 的车/敌人都是绿色系）——比较掩码 IoU 与 ±8px 平移
 *   2) 边缘图（相邻像素差 > 阈值）——比较 IoU 与 ±8px 平移
 * 若 jsnes 存在 8px tile/精灵错位，最佳对齐会在 ±8 而不是 0。
 *
 * 用法：node structural.mjs [--only slot]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.RENDER_AUDIT_OUT || join(HERE, 'out')
const W = 256
const H = 240

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? String(process.argv[i + 1]) : ''
})()

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

/** 绿色系（精灵）掩码：g 明显高于 r/b */
function greenMask(rgb) {
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i += 1) {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    mask[i] = g > 40 && g > r * 1.2 && g > b * 1.15 ? 1 : 0
  }
  return mask
}

/** 边缘掩码：与右侧/下方像素的梯度超过阈值 */
function edgeMask(rgb, threshold = 60) {
  const mask = new Uint8Array(W * H)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x
      if (x + 1 < W) {
        const j = i + 1
        const d = Math.abs(rgb[i * 3] - rgb[j * 3]) + Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]) + Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2])
        if (d > threshold) {
          mask[i] = 1
          continue
        }
      }
      if (y + 1 < H) {
        const j = i + W
        const d = Math.abs(rgb[i * 3] - rgb[j * 3]) + Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]) + Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2])
        if (d > threshold) mask[i] = 1
      }
    }
  }
  return mask
}

/** mask B 平移 (dx,dy) 后与 A 的 IoU */
function iouShift(a, b, dx, dy) {
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

const loadFrames = (which, slot) => {
  const manifest = JSON.parse(readFileSync(join(OUT, which, slot, 'manifest.json'), 'utf8'))
  const map = new Map()
  for (const cap of manifest.captures) map.set(cap.frame, toRGB(readFileSync(join(OUT, which, slot, cap.file))))
  return map
}

const summary = JSON.parse(readFileSync(join(OUT, 'pure', 'index.json'), 'utf8'))
const report = []

const bestShift = (a, b) => {
  const shifts = [-8, -4, 0, 4, 8]
  const grid = []
  for (const dy of shifts) {
    for (const dx of shifts) grid.push({ dx, dy, iou: +iouShift(a, b, dx, dy).toFixed(3) })
  }
  grid.sort((p, q) => q.iou - p.iou)
  return { best: grid[0], atZero: grid.find((g) => g.dx === 0 && g.dy === 0) || { iou: 0 } }
}

for (const entry of summary) {
  if (only && !entry.slot.includes(only)) continue
  const pure = loadFrames('pure', entry.slot)
  const sen = loadFrames('sen', entry.slot)
  const frames = [...pure.keys()].filter((f) => sen.has(f)).sort((a, b) => a - b)
  const rows = []
  for (const frame of frames) {
    const p = pure.get(frame)
    const s = sen.get(frame)
    const pGreen = greenMask(p)
    const sGreen = greenMask(s)
    const pEdge = edgeMask(p)
    const sEdge = edgeMask(s)
    const greenShift = bestShift(pGreen, sGreen)
    const edgeShift = bestShift(pEdge, sEdge)
    rows.push({
      frame,
      green: { best: greenShift.best, atZero: greenShift.atZero.iou },
      edge: { best: edgeShift.best, atZero: edgeShift.atZero.iou },
    })
  }
  report.push({ slot: entry.slot, title: entry.title, frames: rows })
  const bestGreen = Math.max(...rows.map((r) => r.green.best.iou))
  const zeroGreen = Math.max(...rows.map((r) => r.green.atZero))
  console.log(
    `${entry.title.padEnd(16)} 绿色掩码 IoU@0=${zeroGreen.toFixed(3)} 最佳=${bestGreen.toFixed(3)} ` +
      `最佳位移=${rows.map((r) => `(${r.green.best.dx},${r.green.best.dy})`).join('')} ` +
      `边缘 IoU@0=${Math.max(...rows.map((r) => r.edge.atZero)).toFixed(3)}`,
  )
}

writeFileSync(join(OUT, 'structural-compare.json'), JSON.stringify(report, null, 2))
console.log(`\n[structural] 结果 -> ${join(OUT, 'structural-compare.json')}`)
