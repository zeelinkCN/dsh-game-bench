#!/usr/bin/env node
/**
 * 比较 jsnes（pure）与 SEN 的原始帧：逐字节相等性、差异像素数、差异区域的 8px 对齐特征。
 *
 * 用法：node compare.mjs [--only slot] [--json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.RENDER_AUDIT_OUT || join(HERE, 'out')
const W = 256
const H = 240
const PIXELS = W * H

const only = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? String(process.argv[i + 1]) : ''
})()

const slots = JSON.parse(readFileSync(join(OUT, 'pure', 'index.json'), 'utf8'))
const report = []

const loadFrames = (which, slot) => {
  const manifest = JSON.parse(readFileSync(join(OUT, which, slot, 'manifest.json'), 'utf8'))
  const map = new Map()
  for (const cap of manifest.captures) {
    map.set(cap.frame, readFileSync(join(OUT, which, slot, cap.file)))
  }
  return map
}

/** 比较同帧；返回差异统计（按 8x8 tile 统计差异格子数，便于判断是否整 tile 错位） */
function diffFrames(a, b) {
  if (a.length !== b.length) return { mismatched: -1 }
  let mismatched = 0
  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1
  const tileDiff = new Uint32Array((W / 8) * (H / 8))
  for (let i = 0; i < PIXELS; i += 1) {
    if (a.readUInt32LE(i * 4) === b.readUInt32LE(i * 4)) continue
    mismatched += 1
    const x = i % W
    const y = (i / W) | 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    tileDiff[(((y / 8) | 0) * (W / 8)) + ((x / 8) | 0)] += 1
  }
  // 找出“几乎整块都不同”的 tile（>32/64 像素不同）
  const badTiles = []
  for (let t = 0; t < tileDiff.length; t += 1) {
    if (tileDiff[t] > 32) badTiles.push([t % (W / 8), (t / (W / 8)) | 0])
  }
  return { mismatched, minX, minY, maxX, maxY, badTiles }
}

for (const entry of slots) {
  if (only && !entry.slot.includes(only)) continue
  const pure = loadFrames('pure', entry.slot)
  const sen = loadFrames('sen', entry.slot)
  const frames = [...pure.keys()].filter((f) => sen.has(f)).sort((a, b) => a - b)
  const rows = []
  for (const frame of frames) {
    const d = diffFrames(pure.get(frame), sen.get(frame))
    rows.push({
      frame,
      mismatchedPixels: d.mismatched,
      percent: +((d.mismatched / PIXELS) * 100).toFixed(2),
      bbox: d.mismatched > 0 ? [d.minX, d.minY, d.maxX, d.maxY] : null,
      wholeTiles: d.badTiles?.length ?? 0,
    })
  }
  report.push({ slot: entry.slot, title: entry.title, frames: rows })
  const best = rows.reduce((m, r) => Math.min(m, r.percent), 100)
  const worst = rows.reduce((m, r) => Math.max(m, r.percent), 0)
  console.log(
    `${entry.title.padEnd(16)} diff% min=${best.toFixed(2)} max=${worst.toFixed(2)}  ` +
      rows.map((r) => `${r.frame}:${r.percent}%`).join(' '),
  )
}

writeFileSync(join(OUT, 'compare-pure-vs-sen.json'), JSON.stringify(report, null, 2))
console.log(`\n[compare] 结果 -> ${join(OUT, 'compare-pure-vs-sen.json')}`)
