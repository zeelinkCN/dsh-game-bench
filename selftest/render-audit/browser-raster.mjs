#!/usr/bin/env node
/**
 * 渲染诊断 · 真实 Chrome 栅格化实测
 *
 * 复刻 client.js 的画布展示方式（canvas 内部 256x240；.gb-screen 固定 CSS 尺寸；
 * canvas width/height:100%；image-rendering: pixelated / crisp-edges / auto），
 * 用 headless Chrome 截图后测量：
 *   - 源像素列在设备像素上的实际宽度分布（是否 3/4 交替）
 *   - 8px tile 边界实际宽度
 *   - 是否出现灰度/平滑（非纯黑白）像素
 *
 * 用法：node browser-raster.mjs
 * 产出：out/browser/*.png + out/browser/raster-cases.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.RENDER_AUDIT_OUT ? join(process.env.RENDER_AUDIT_OUT, 'browser') : join(HERE, 'out', 'browser')
const PROFILE = join(HERE, 'tmp', 'chrome-profile-raster')
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

mkdirSync(OUT, { recursive: true })
mkdirSync(join(HERE, 'tmp'), { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const W = 256
const H = 240

/**
 * 测试图案（画在 256x240 画布上）：
 *   y 0..79    竖直 1px 黑白条纹（测列宽）
 *   y 80..159  水平 1px 黑白条纹（测行高）
 *   y 160..239 8px 网格（白线宽 1px，其余深灰；测 8px tile 边界）
 */
const drawPattern = `
const c = document.getElementById('c')
const ctx = c.getContext('2d')
const img = ctx.createImageData(256, 240)
const d = img.data
for (let y = 0; y < 240; y++) {
  for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4
    let v = 0
    if (y < 80) v = x % 2 ? 255 : 0
    else if (y < 160) v = y % 2 ? 255 : 0
    else v = x % 8 === 0 || y % 8 === 0 ? 255 : 40
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
}
ctx.putImageData(img, 0, 0)
document.title = 'ready'
`

const makeHtml = (cssW, cssH, rendering) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#000;overflow:hidden}
  #screen{
    position:relative;width:${cssW}px;height:${cssH}px;overflow:hidden;background:#000;
    image-rendering:${rendering};
  }
  #c{display:block;width:100%;height:100%;background:#000;image-rendering:${rendering};}
</style></head><body>
<div id="screen"><canvas id="c" width="256" height="240"></canvas></div>
<script>${drawPattern}</script>
</body></html>`

const runChrome = (htmlPath, shotPath, cssW, cssH, dpr) =>
  new Promise((resolveRun) => {
    rmSync(PROFILE, { recursive: true, force: true })
    mkdirSync(PROFILE, { recursive: true })
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--force-device-scale-factor=${dpr}`,
      `--window-size=${cssW},${cssH}`,
      `--user-data-dir=${PROFILE}`,
      `--screenshot=${shotPath}`,
      '--virtual-time-budget=1500',
      `file://${htmlPath}`,
    ]
    const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 30000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code, stderr, shot: existsSync(shotPath) ? shotPath : '' })
    })
  })

const scenarios = [
  { name: 'native-256x240-dpr1', css: [256, 240], dpr: 1, rendering: 'pixelated' },
  { name: 'fit-933x700-dpr1-pixelated', css: [933, 700], dpr: 1, rendering: 'pixelated' },
  { name: 'fit-933x700-dpr1-crispedges', css: [933, 700], dpr: 1, rendering: 'crisp-edges' },
  { name: 'fit-933x700-dpr1-auto', css: [933, 700], dpr: 1, rendering: 'auto' },
  { name: 'fit-933x700-dpr2-pixelated', css: [933, 700], dpr: 2, rendering: 'pixelated' },
  { name: 'fit-827x620-dpr1-pixelated', css: [827, 620], dpr: 1, rendering: 'pixelated' },
]

const results = []
for (const scenario of scenarios) {
  const [cssW, cssH] = scenario.css
  const htmlPath = join(OUT, `${scenario.name}.html`)
  const shotPath = join(OUT, `${scenario.name}.png`)
  writeFileSync(htmlPath, makeHtml(cssW, cssH, scenario.rendering))
  const run = await runChrome(htmlPath, shotPath, cssW, cssH, scenario.dpr)
  results.push({ ...scenario, html: htmlPath, png: run.shot, chromeExit: run.code, chromeStderr: run.stderr.slice(-300) })
  console.log(`[browser] ${scenario.name} exit=${run.code} shot=${run.shot ? 'ok' : 'missing'}`)
}

writeFileSync(join(OUT, 'raster-cases.json'), JSON.stringify(results, null, 2))
console.log(`\n[browser] 截图 -> ${OUT}；接着运行：python3 raster-analyze.py`)
