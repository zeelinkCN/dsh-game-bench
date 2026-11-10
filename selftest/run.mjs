#!/usr/bin/env node
/**
 * 拾光游戏厅（Game Bench）离线验收：真实 headless Chrome + 真实 React 18 + 真实 client.js
 * + 真实 engine.js/jsnes 渲染，后端全部走本地 mock（server.mjs）。
 * 产出 PASS/FAIL 清单 + 截图（shots/）+ last-run.log。
 *
 * 覆盖 docs/CONTRACT.md §6 的离线矩阵：
 *   模块/slot、游戏库、播放器（真实 canvas 像素 + 帧推进）、键盘/不抢键、存档（IndexedDB）、
 *   市场（合集/安装/已安装）、错误态（auth/offline）、主题、响应式、运行期无异常。
 * 真实 DSH 页面验收见 real-page.mjs。
 *
 * 用法：
 *   node run.mjs                          # 验收 ../client.js + ../engine.js
 *   GB_CLIENT=/abs/fixture.js node run.mjs    # 基础设施自测
 *   GB_INFRA=1 node run.mjs               # 跳过工件缺失的早退（用于验证 harness 本身）
 *
 * 依赖：Google Chrome（无 npm 依赖，Node 24 自带 WebSocket / fetch）。
 * 约束：Chrome profile 写到 ./tmp/chrome-profile，结束清理；不碰 ~/.dsh、不改插件源码。
 * 退出码：0 全绿 / 1 有 FAIL / 2 工件缺失（client/engine/jsnes 未交付）/ 3 找不到 Chrome / 4 看门狗超时。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SHOTS = join(HERE, 'shots')
const TMP = join(HERE, 'tmp')
const GB_INFRA = process.env.GB_INFRA === '1'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
  process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '',
  process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : '',
  process.platform === 'linux' ? '/usr/bin/google-chrome' : '',
  process.platform === 'linux' ? '/usr/bin/chromium' : '',
].filter((candidate) => candidate && existsSync(candidate))
const CHROME = CHROME_CANDIDATES[0] || ''
const NODE = process.execPath

const CLIENT = process.env.GB_CLIENT ? resolve(process.env.GB_CLIENT) : join(PLUGIN, 'client.js')
const ENGINE = process.env.GB_ENGINE ? resolve(process.env.GB_ENGINE) : join(PLUGIN, 'engine.js')
const JSNES = process.env.GB_JSNES ? resolve(process.env.GB_JSNES) : join(PLUGIN, 'vendor', 'jsnes.min.js')

mkdirSync(SHOTS, { recursive: true })
mkdirSync(TMP, { recursive: true })
try {
  for (const f of readdirSync(SHOTS)) if (/\.png$/i.test(f)) rmSync(join(SHOTS, f), { force: true })
} catch { /* ignore */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* bail out early with distinct exit codes */
const missing = []
if (!existsSync(CLIENT)) missing.push(`client.js（${CLIENT}）`)
if (!existsSync(ENGINE)) missing.push(`engine.js（${ENGINE}）`)
if (!existsSync(JSNES)) missing.push(`vendor/jsnes.min.js（${JSNES}）`)
if (missing.length && !GB_INFRA) {
  console.error('\n[等待工件] 以下被测文件还不存在：')
  for (const m of missing) console.error('  - ' + m)
  console.error('\n基础设施（server.mjs / harness.html / run.mjs）已就绪，等队友交付后重跑。')
  console.error('可先 GB_INFRA=1 GB_CLIENT=<fixture.js> node run.mjs 自测 harness 本身。')
  process.exit(2)
}
if (!existsSync(CHROME)) {
  console.error(`\n[环境错误] 找不到 Chrome：${CHROME}`)
  process.exit(3)
}

/* ---------------- 断言 ---------------- */
const passed = []
const failures = []
function check(label, ok, extra) {
  if (ok) {
    passed.push(label)
    console.log(`  ✓ ${label}${extra === undefined ? '' : ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})`}`)
  } else {
    failures.push({ label, extra })
    console.log(`  ✗ ${label}${extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`)
  }
}
function section(name) { console.log(`\n${name}`) }
const brief = (v, n = 320) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > n ? s.slice(0, n) + '…' : s
}

/* ---------------- mock backend ---------------- */
const server = spawn(NODE, [join(HERE, 'server.mjs')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, GB_CLIENT: CLIENT },
})
let serverInfo = {}
const port = await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('mock server timeout (10s)')), 10000)
  server.stdout.on('data', (buf) => {
    const text = buf.toString()
    const m = /\{"port":(\d+)/.exec(text)
    if (m) {
      try { serverInfo = JSON.parse(text.slice(text.indexOf('{'))) } catch { /* ignore */ }
      clearTimeout(timer)
      res(Number(m[1]))
    } else console.log('[server] ' + text.trim())
  })
  server.on('exit', (code) => rej(new Error('mock server exited: ' + code)))
}).catch((err) => {
  console.error('[FATAL] ' + err.message)
  process.exit(1)
})
const BASE = `http://127.0.0.1:${port}`
console.log(`[mock] ${BASE}`)
console.log(`[mock] builtin=${serverInfo.builtin} market=${serverInfo.market} collections=${serverInfo.collections}`)
console.log(`[mock] engine=${serverInfo.engine} jsnes=${serverInfo.jsnes} client=${serverInfo.client}`)

/* 兜底 watchdog */
let chrome = null
const watchdog = setTimeout(() => {
  console.error('\n[watchdog] run.mjs 超过 35 分钟未结束，强制退出')
  try { chrome && chrome.kill('SIGKILL') } catch { /* ignore */ }
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(4)
}, 35 * 60 * 1000)
watchdog.unref?.()

async function config(patch) {
  const r = await fetch(`${BASE}/__config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  })
  return r.json()
}
const calls = async () => (await fetch(`${BASE}/__calls`)).json()
const resetCalls = async () => { await fetch(`${BASE}/__clearcalls`, { method: 'POST' }) }
const findCalls = async (path, searchRe) => (await calls()).filter((c) =>
  c.path === path && (!searchRe || searchRe.test(decodeURIComponent(c.search || ''))))

/* ---------------- Chrome + CDP ---------------- */
const profileDir = join(TMP, 'chrome-profile')
try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = new Map() }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', rej, { once: true })
    })
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
        return
      }
      if (msg.method) for (const fn of this.listeners.get(msg.method) || []) fn(msg.params)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method} (45s)`))
      }, 45000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1440,900',
  '--remote-debugging-port=0',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-dev-shm-usage',
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let chromeStderr = ''
chrome.stderr.on('data', (b) => { chromeStderr += b.toString() })

const devtoolsFile = join(profileDir, 'DevToolsActivePort')
const debugPort = await (async () => {
  for (let i = 0; i < 120; i++) {
    if (existsSync(devtoolsFile)) {
      const line = readFileSync(devtoolsFile, 'utf8').split('\n')[0].trim()
      if (line) return Number(line)
    }
    await sleep(100)
  }
  throw new Error('Chrome DevToolsActivePort timeout\n' + chromeStderr.slice(-800))
})()
let pageWs = null
for (let i = 0; i < 80 && !pageWs; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) pageWs = page.webSocketDebuggerUrl
  } catch { /* retry */ }
  if (!pageWs) await sleep(100)
}
if (!pageWs) throw new Error('no page target')

const cdp = new CDP(pageWs)
await cdp.connect()
const errors = []
const unexpectedErrors = []
let allowErrors = false
cdp.on('Runtime.exceptionThrown', (p) => {
  const text = p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception'
  errors.push(text)
  if (!allowErrors) unexpectedErrors.push(text)
})
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    errors.push(text)
    if (!allowErrors) unexpectedErrors.push(text)
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Network.enable')
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })

/* ---------------- 通用 helpers ---------------- */
async function evaluate(expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) {
    throw new Error(`eval failed: ${brief(expression)}\n${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`)
  }
  return res.result.value
}
async function waitFor(expression, label, timeout = 12000, interval = 100) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      last = await evaluate(expression)
      if (last) return last
    } catch (err) { last = String(err) }
    await sleep(interval)
  }
  throw new Error(`waitFor timeout: ${label}; last=${brief(last)}`)
}
async function waitUntil(fn, label, timeout = 8000, interval = 150) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) { last = String(err) }
    await sleep(interval)
  }
  throw new Error(`waitUntil timeout: ${label}; last=${brief(last)}`)
}

async function screenshot(name, options = {}) {
  await sleep(options.settle === undefined ? 320 : options.settle)
  const params = { format: 'png' }
  if (options.clip) params.clip = options.clip
  const { data } = await cdp.send('Page.captureScreenshot', params)
  const file = join(SHOTS, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`  · screenshot ${file}`)
  return file
}
const shots = []
async function S(name, options) {
  const file = await screenshot(name, options)
  shots.push(file)
  return file
}
async function screenshotRegion(selector, name, scale = 3, pad = 14) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })()`)
  if (!box || box.w < 2 || box.h < 2) return false
  const file = await screenshot(name, {
    settle: 0,
    clip: {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: Math.max(2, box.w + pad * 2), height: Math.max(2, box.h + pad * 2), scale,
    },
  })
  shots.push(file)
  return file
}
async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
}
async function setColorScheme(theme) {
  await cdp.send('Emulation.setEmulatedMedia', {
    media: '', features: [{ name: 'prefers-color-scheme', value: theme }],
  })
}
const setTheme = (theme) => evaluate(`(() => {
  document.documentElement.dataset.theme = ${JSON.stringify(theme)}
  document.documentElement.classList.toggle('dark', ${JSON.stringify(theme)} === 'dark')
  return getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
})()`)
async function navigate(url) {
  await cdp.send('Page.navigate', { url })
  await waitFor('document.readyState === "complete"', 'document ready', 15000)
}
const gotoHarness = (extra = '') => navigate(`${BASE}/${extra}`)
async function reload() {
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor('document.readyState === "complete"', 'reload ready', 15000)
}
async function waitMounted(timeout = 20000) {
  return waitFor('window.__mounted === true || !!window.__mountError', 'client mount', timeout)
}
async function assertMountedOk() {
  const st = await evaluate('({ mounted: window.__mounted, mountError: window.__mountError, errors: window.__errors })')
  check('client.js 挂载成功（apply 无抛错）', st.mounted === true, brief(st.mountError || st.errors?.slice(0, 2)))
  return st.mounted === true
}
function clickSel(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    try { el.scrollIntoView({ block: 'center' }) } catch (_) {}
    el.click()
    return true
  })()`)
}
/** 依次尝试候选选择器 / 文案，返回命中的 selector 或 null */
async function clickFirst(selectors, textRe) {
  const bySel = await evaluate(`(() => {
    const sels = ${JSON.stringify(selectors || [])}
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
          try { el.scrollIntoView({ block: 'center' }) } catch (_) {}
          el.click()
          return s
        }
      }
    }
    return null
  })()`)
  if (bySel) return bySel
  if (!textRe) return null
  return evaluate(`(() => {
    const re = ${textRe instanceof RegExp ? textRe.toString() : String(textRe)}
    const nodes = [...document.querySelectorAll('button, [role="tab"], [role="button"], a, [data-gb-tab], [data-gb-view]')]
    for (const el of nodes) {
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      const text = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')
      if (re.test(text)) {
        try { el.scrollIntoView({ block: 'center' }) } catch (_) {}
        el.click()
        return 'text:' + (el.textContent || '').trim().slice(0, 24)
      }
    }
    return null
  })()`)
}
const visible = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const r = el.getBoundingClientRect()
  const st = getComputedStyle(el)
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
})()`)
const textOf = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  return el ? el.textContent.trim() : null
})()`)
const countSel = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const gbState = () => evaluate('window.__gbState()')
const gbCards = () => evaluate('window.__gbCards()')
const canvasStats = () => evaluate('window.__gbCanvasStats()')
/** 等播放器 ready 并点击「开始」遮罩（若已自动解锁音频则直接返回 false） */
async function startPlayer(label = 'player start', timeout = 9000) {
  try {
    await waitFor(`!!document.querySelector('[data-gb-start]') || (() => { const p = document.querySelector('[data-gb-player]'); return !!(p && p.getAttribute('data-gb-phase') === 'ready') })()`, label, timeout)
  } catch (err) { /* 无遮罩也可能已自动开始 */ }
  const overlay = await evaluate(`!!document.querySelector('[data-gb-start]')`)
  if (overlay) {
    await clickSel('[data-gb-start]')
    await sleep(700)
  } else {
    await sleep(400)
  }
  return overlay
}

const TAB_SELECTORS = (name) => [
  `[data-gb-tab="${name}"]`,
  `[data-gb-view-tab="${name}"]`,
  `[data-gb="tab"][data-tab="${name}"]`,
]
const TAB_TEXT = { library: /游戏库|库|library/i, market: /市场|商店|market/i, player: /播放|游戏|player/i }

async function gotoTab(name) {
  const hit = await clickFirst(TAB_SELECTORS(name), TAB_TEXT[name])
  await sleep(500)
  return hit
}

async function overflowReport() {
  return evaluate(`(() => {
    const root = document.querySelector('[data-gb="root"]')
    const doc = document.documentElement
    return {
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      bodyScroll: document.body.scrollWidth,
      bodyClient: document.body.clientWidth,
      rootScroll: root ? root.scrollWidth : null,
      rootClient: root ? root.clientWidth : null,
      viewport: window.innerWidth,
    }
  })()`)
}

/* ---------------- 流程 ---------------- */
let fatal = null
try {
  /* ================================================================ *
   * [0] 工件与 mock 数据
   * ================================================================ */
  section('[0] 工件 / mock 数据')
  console.log(`  client: ${CLIENT}`)
  console.log(`  engine: ${ENGINE} (${existsSync(ENGINE) ? 'ok' : 'missing'})`)
  console.log(`  jsnes : ${JSNES} (${existsSync(JSNES) ? 'ok' : 'missing'})`)
  check('内置游戏清单非空（public demo + 本机 local 合并，Host 会合并两份 manifest）', (serverInfo.builtin || 0) >= 1, serverInfo.builtin)
  check('市场切片 ≥60 款（真实资源库）', (serverInfo.market || 0) >= 60, serverInfo.market)
  check('市场合集 ≥2 个', (serverInfo.collections || '').split(',').filter(Boolean).length >= 2, serverInfo.collections)
  if (!existsSync(ENGINE) || !existsSync(JSNES)) {
    check('模拟器运行时（engine.js + jsnes）已交付', false, '缺失 → 播放器/画面断言会 FAIL')
  } else {
    check('模拟器运行时（engine.js + jsnes）已交付', true)
  }
  const GAMEPADS_FILE = join(PLUGIN, 'gamepads.js')
  const PAD_SETTINGS_FILE = join(PLUGIN, 'gamepad-settings.js')
  check('手柄模块（gamepads.js + gamepad-settings.js）已交付',
    existsSync(GAMEPADS_FILE) && existsSync(PAD_SETTINGS_FILE),
    `gamepads=${existsSync(GAMEPADS_FILE)} settings=${existsSync(PAD_SETTINGS_FILE)}（缺失时 [5d] 会 FAIL）`)

  await gotoHarness()
  await waitMounted()
  await setViewport(1440, 900)
  await setColorScheme('dark')
  await setTheme('dark')
  await sleep(300)
  const mountedOk = await assertMountedOk()
  if (!mountedOk) {
    const st = await evaluate('({ mountError: window.__mountError, errors: window.__errors })')
    throw new Error('client 未能挂载：' + brief(st.mountError || st.errors, 500))
  }

  /* ================================================================ *
   * [1] 模块加载 / slot 注册 / 无异常
   * ================================================================ */
  section('[1] 模块加载 / slot 注册')
  const entry = await evaluate(`(() => {
    const e = window.__pluginEntry || {}
    return { hasEntry: !!window.__pluginEntry, id: e && (e.id || e.name) || null, hasFactory: !!(e && typeof e.factory === 'function'), injected: window.__slotInjections, injects: window.__pluginInjects || [], selected: window.__selectedPanels }
  })()`)
  check('__ModuleLoader__.load 被调用且 factory 是可执行函数', entry.hasEntry && entry.hasFactory, brief(entry))
  check('inject 声明包含 slots（以及 locale/layout 等）',
    (entry.injects || []).includes('slots'), brief(entry.injects))

  const specs = await evaluate(`(() => {
    const out = {}
    for (const [name, spec] of Object.entries(window.__slotSpecs)) {
      const label = typeof spec.label === 'function' ? (() => { try { return spec.label() } catch (_) { return null } })() : (spec.label || null)
      out[name] = { id: spec.id || null, order: spec.order == null ? null : spec.order, name: spec.name || null, label }
    }
    return out
  })()`)
  check('main slot 注册成功', !!specs.main, brief(specs.main))
  check('sidebar.panellist slot 注册成功（侧栏入口）', !!specs['sidebar.panellist'], brief(specs['sidebar.panellist']))
  const panellist = specs['sidebar.panellist'] || {}
  check('侧栏入口有 id 与可读 label', !!panellist.id && (typeof panellist.label === 'string' ? panellist.label.length > 0 : panellist.label !== null), brief(panellist))
  check('两个 slot 都注入到 ctx.slots', ['main', 'sidebar.panellist'].every((n) => (entry.injected || []).includes(n)), brief(entry.injected))
  const iconRendered = await evaluate(`(() => { const el = document.getElementById('sidebar-icon'); return { children: el.children.length, html: el.innerHTML.length, entry: !!el.querySelector('[data-gb-entry]'), label: (el.querySelector('[data-gb-entry]') || {}).getAttribute ? (el.querySelector('[data-gb-entry]').getAttribute('aria-label') || '') : '' } })()`)
  check('侧栏入口组件真实渲染出内容', iconRendered.children > 0 && iconRendered.html > 30, brief(iconRendered))
  check('侧栏入口带 [data-gb-entry]（real-page.mjs 定位钩子）', iconRendered.entry === true, brief(iconRendered))
  const iconMetrics = await evaluate(`(() => {
    const el = document.querySelector('[data-gb-entry]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const svg = el.querySelector('svg')
    const sr = svg ? svg.getBoundingClientRect() : null
    const cs = getComputedStyle(el)
    const svgCs = svg ? getComputedStyle(svg) : null
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      radius: cs.borderRadius, bg: cs.backgroundImage.slice(0, 60),
      transform: cs.transform, boxShadow: cs.boxShadow,
      svgW: sr ? Math.round(sr.width) : null, svgH: sr ? Math.round(sr.height) : null,
      svgRatio: sr && r.width ? +(sr.width / r.width).toFixed(2) : null,
      svgTransform: svgCs ? svgCs.transform : null,
      overflow: svg && sr ? (sr.left >= r.left - 0.5 && sr.top >= r.top - 0.5 && sr.right <= r.right + 0.5 && sr.bottom <= r.bottom + 0.5) : null,
    }
  })()`)
  check('侧栏图标：外层 20×20、圆角、内容不裁切、无 scale',
    !!iconMetrics && Math.abs(iconMetrics.w - 20) <= 1 && Math.abs(iconMetrics.h - 20) <= 1
      && parseFloat(iconMetrics.radius) > 0
      && iconMetrics.overflow === true
      && !/scale/i.test(iconMetrics.transform || ''),
    brief(iconMetrics))
  check('侧栏图标：内层 SVG 方形、尺寸不超出外层',
    !!iconMetrics && iconMetrics.svgW !== null && iconMetrics.svgW > 8 && iconMetrics.svgW <= 21
      && Math.abs(iconMetrics.svgW - iconMetrics.svgH) <= 1,
    brief({ svgW: iconMetrics && iconMetrics.svgW, svgH: iconMetrics && iconMetrics.svgH, ratio: iconMetrics && iconMetrics.svgRatio }))
  await screenshotRegion('#sidebar-icon', '11-sidebar-entry.png', 6, 12)
  check('无 console.error / pageerror（挂载期）', unexpectedErrors.length === 0, brief(unexpectedErrors.slice(0, 3)))

  const root = await evaluate(`(() => {
    const el = document.querySelector('[data-gb="root"]')
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    return { found: true, w: Math.round(r.width), h: Math.round(r.height), view: el.getAttribute('data-gb-view'), tab: el.getAttribute('data-gb-tab') }
  })()`)
  check('主面板根节点 [data-gb="root"] 存在且有尺寸', root.found && root.w > 300 && root.h > 200, brief(root))

  /* ================================================================ *
   * [2] 游戏库：7 张内置卡片
   * ================================================================ */
  section('[2] 游戏库（内置清单：public demo + 本机 local 合并）')
  await gotoTab('library')
  let cards = []
  try {
    await waitFor(`document.querySelectorAll('[data-gb-card]').length >= 1`, 'library cards', 15000)
  } catch (err) { /* 断言里报告实际数量 */ }
  cards = await gbCards()
  const libraryData = await evaluate(`(async () => { const r = await fetch('/game-bench/api/library'); const j = await r.json(); return { builtinCount: j.data.builtinCount, games: j.data.games.map(g => ({ id: g.id, title: g.title, builtin: g.builtin })) } })()`)
  const expectedBuiltinCount = libraryData.builtinCount
  const firstBuiltinId = (cards[0] || {}).id || null
  check(`游戏库渲染与 /library 一致的内置卡片数（${expectedBuiltinCount} 张）`,
    cards.length === expectedBuiltinCount && expectedBuiltinCount >= 1,
    `${cards.length} 张：${brief(cards.map((c) => c.text).slice(0, 10), 240)}`)
  check('卡片标题非空', cards.length > 0 && cards.every((c) => c.text && c.text.length > 0), brief(cards.slice(0, 3).map((c) => c.text)))
  check('卡片封面 <img> 存在', cards.length > 0 && cards.every((c) => c.imgSrc), brief(cards.slice(0, 3).map((c) => c.imgSrc)))
  const coversLoaded = cards.length > 0 && cards.every((c) => c.imgNatural > 0)
  check('封面图片真实加载（naturalWidth > 0，非 404 占位）', coversLoaded, brief(cards.map((c) => c.imgNatural)))
  check('/library 内置游戏全部 installed', libraryData.games.filter((g) => g.builtin).every((g) => g && g.id && g.title) && libraryData.games.filter((g) => g.builtin).length === expectedBuiltinCount, { builtinCount: expectedBuiltinCount })
  const titleKnown = cards.some((c) => /超级玛丽|魂斗罗|星光试航|Star Pilot/i.test(c.text))
  check('内置清单包含可识别标题（本机私有经典 或 公开 demo）', titleKnown, brief(cards.map((c) => c.text).slice(0, 10), 240))
  console.log(`  · 本机内置：${expectedBuiltinCount} 款（public demo + games/builtin.local.json 合并）`)
  await S('00-library-dark.png')

  /* ================================================================ *
   * [3] 播放器：点卡片 → 开始 → 真实 canvas
   * ================================================================ */
  section('[3] 播放器（真实 canvas / 帧推进）')
  const firstCard = cards[0] || null
  const firstTitle = firstCard ? firstCard.text.split('\n')[0].trim() : ''
  // 优先玩本机私有经典（超级玛丽/魂斗罗）；干净 clone 下没有则玩公开 demo
  const clickRes = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-gb-card]')]
    const card = cards.find((c) => /超级玛丽|魂斗罗/.test(c.textContent || '')) || cards[0]
    if (!card) return { hit: false }
    const el = card.querySelector('.gb-card-hit') || card.querySelector('button') || card
    try { el.scrollIntoView({ block: 'center' }) } catch (_) {}
    el.click()
    return { hit: true, id: card.getAttribute('data-gb-card') || card.getAttribute('data-id'), text: (card.textContent || '').trim().slice(0, 40) }
  })()`)
  const playedId = clickRes && clickRes.id
  check('点击内置卡片（优先本机经典）', !!(clickRes && clickRes.hit), brief(clickRes))
  let playerShown = false
  try {
    await waitFor(`(() => {
      const root = document.querySelector('[data-gb="root"]')
      return root && (root.getAttribute('data-gb-view') === 'player') && (!!document.querySelector('[data-gb-start]') || (() => { const p = document.querySelector('[data-gb-player]'); return !!(p && p.getAttribute('data-gb-phase') === 'ready') })())
    })()`, 'player view', 12000)
    playerShown = true
  } catch (err) { /* 断言报告 */ }
  const viewState = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return { view: r && r.getAttribute('data-gb-view'), start: !!document.querySelector('[data-gb-start]'), canvas: !!document.querySelector('[data-gb="root"] canvas') } })()`)
  check('进入播放器视图（data-gb-view="player"）', playerShown && viewState.view === 'player', brief(viewState))
  const readyNoOverlay = await evaluate(`(() => { const p = document.querySelector('[data-gb-player]'); return !!(p && p.getAttribute('data-gb-phase') === 'ready' && !document.querySelector('[data-gb-start]')) })()`)
  check('出现「开始」遮罩 [data-gb-start]（若点击卡片已自动解锁音频则不出现）',
    viewState.start === true || readyNoOverlay === true, brief({ viewState, readyNoOverlay }))
  await S('01-player-start-overlay.png')
  if (viewState.start) await clickSel('[data-gb-start]')
  else await startPlayer('player start fallback')
  await sleep(400)
  let canvasReady = false
  try {
    await waitFor(`(() => { const s = window.__gbCanvasStats(); return s && s.cw > 0 && s.ch > 0 })()`, 'canvas ready', 10000)
    canvasReady = true
  } catch (err) { /* 断言报告 */ }
  const cv = await canvasStats()
  check('canvas 出现且内部分辨率为 256×240', canvasReady && cv && cv.cw === 256 && cv.ch === 240, brief(cv))
  let pixelsOk = false
  try {
    await waitFor(`(() => { const s = window.__gbCanvasStats(); return s && s.nonBlack > 500 })()`, 'canvas non-black > 500', 12000)
    pixelsOk = true
  } catch (err) { /* 断言报告 */ }
  const cv2 = await canvasStats()
  check('canvas 真实像素非全黑（非黑像素 > 500）', pixelsOk, brief({ nonBlack: cv2 && cv2.nonBlack, hash: cv2 && cv2.hash, err: cv2 && cv2.err }))
  const engineOk = await evaluate('window.__gbEngines.length > 0 && !window.__gbEngines[0].destroyed')
  check('engine 实例已创建且未销毁（window.GameBenchCore.create 被真实调用）', engineOk)
  const st1 = await gbState()
  // 画面像素：静帧（如标题画面）不变化是合理的，采样多次，配合 engine 帧计数判断
  let hashChanged = false
  let prevHash = cv2 && cv2.hash
  for (let i = 0; i < 5 && !hashChanged; i++) {
    await sleep(380)
    const sample = await canvasStats()
    if (sample && prevHash != null && sample.hash !== prevHash) hashChanged = true
    prevHash = sample && sample.hash
  }
  let st2 = await gbState()
  let framesGrew = typeof st1.frames === 'number' && typeof st2.frames === 'number' ? st2.frames > st1.frames : null
  for (let i = 0; i < 6 && framesGrew !== true; i++) {
    await sleep(500)
    st2 = await gbState()
    if (typeof st1.frames === 'number' && typeof st2.frames === 'number' && st2.frames > st1.frames) framesGrew = true
  }
  check('帧计数增长（engine onState.frames 递增）', framesGrew === true, framesGrew === null ? 'client 未透出 onState.frames' : `${st1.frames} → ${st2.frames}`)
  check('帧在推进（画面像素变化 或 engine frames 递增）', hashChanged || framesGrew === true,
    brief({ hashChanged, frames: `${st1.frames} → ${st2.frames}` }))
  check('engine 未崩溃（crashed=false）', st2.crashed === false, brief({ crashed: st2.crashed, audio: st2.audio }))
  await S('02-player-running.png')

  /* ================================================================ *
   * [3c] 播放器画面模式（fit / stretch / pixel / 全屏结构）
   * ================================================================ */
  section('[3c] 播放器画面模式（默认 pixel / fit / stretch 逐一切换）')
  const modeHooks = await evaluate(`(() => {
    const btn = document.querySelector('[data-gb-screen-mode]')
    const dbg = window.__GAME_BENCH__
    const dpr = window.devicePixelRatio || 1
    let sizes = null
    let dprSizes = null
    try {
      if (dbg && typeof dbg.screenSizeFor === 'function') {
        sizes = {
          fit: dbg.screenSizeFor('fit', 1000, 800, dpr),
          stretch: dbg.screenSizeFor('stretch', 1000, 500, dpr),
          pixel: dbg.screenSizeFor('pixel', 1000, 800, dpr),
        }
        dprSizes = {}
        ;[1, 1.25, 1.5, 2].forEach((ratio) => {
          const s = dbg.screenSizeFor('pixel', 960, 720, ratio)
          dprSizes[String(ratio)] = {
            w: s.w, h: s.h,
            kx: s.w * ratio / 256, ky: s.h * ratio / 240,
          }
        })
      }
    } catch (_) { sizes = null; dprSizes = null }
    return {
      btn: btn ? btn.getAttribute('data-gb-screen-mode') : null,
      fullscreenBtn: !!document.querySelector('[data-gb-fullscreen]'),
      dbg: !!dbg,
      dpr,
      sizes,
      dprSizes,
    }
  })()`)
  check('画面模式按钮存在且默认 pixel（生产默认已改为整数倍像素）', modeHooks.btn === 'pixel', brief(modeHooks.btn))
  check('全屏按钮存在（[data-gb-fullscreen]）', modeHooks.fullscreenBtn === true)
  check('验收句柄 window.__GAME_BENCH__ + screenSizeFor 可用', modeHooks.dbg === true && !!modeHooks.sizes, brief({ dbg: modeHooks.dbg, dpr: modeHooks.dpr }))
  if (modeHooks.sizes) {
    const s = modeHooks.sizes
    check('fit = 4:3（w/h ≈ 1.333）', Math.abs(s.fit.w / s.fit.h - 4 / 3) < 0.01, s.fit)
    check('stretch 精确等于可用尺寸（与 DPR 无关）', s.stretch.w === 1000 && s.stretch.h === 500, s.stretch)
    check('pixel：物理像素为 256/240 整数倍且两轴 scale 相同',
      Math.abs(s.pixel.w * modeHooks.dpr / 256 - Math.round(s.pixel.w * modeHooks.dpr / 256)) < 1e-6
        && Math.abs(s.pixel.h * modeHooks.dpr / 240 - Math.round(s.pixel.h * modeHooks.dpr / 240)) < 1e-6
        && Math.abs(s.pixel.w * modeHooks.dpr / 256 - s.pixel.h * modeHooks.dpr / 240) < 1e-6,
      s.pixel)
  }
  // screenSizeFor 第 4 参 DPR：DPR 1 / 1.25 / 1.5 / 2 下物理像素缩放必须是同一个整数（无小数物理像素）
  if (modeHooks.dprSizes) {
    for (const ratio of ['1', '1.25', '1.5', '2']) {
      const item = modeHooks.dprSizes[ratio]
      const kx = item.kx
      const ky = item.ky
      check(`DPR=${ratio}：pixel 物理像素整数倍（w*dpr/256 = h*dpr/240 = 同一整数）`,
        Math.abs(kx - Math.round(kx)) < 1e-6
          && Math.abs(ky - Math.round(ky)) < 1e-6
          && Math.round(kx) >= 1
          && Math.round(kx) === Math.round(ky),
        { dpr: Number(ratio), w: item.w, h: item.h, kx: +kx.toFixed(4), ky: +ky.toFixed(4) })
    }
  }
  const measureCanvas = () => evaluate(`(() => {
    const c = document.querySelector('[data-gb="root"] canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    const frame = document.querySelector('[data-gb-stage]')
    const dpr = window.devicePixelRatio || 1
    const modeEl = document.querySelector('[data-gb-screen-mode]')
    const mode = modeEl ? modeEl.getAttribute('data-gb-screen-mode') : null
    let exp = null
    try {
      const outer = document.querySelector('[data-gb-player] .gb-player-stage') || (frame && frame.parentElement)
      const or = outer ? outer.getBoundingClientRect() : null
      const pad = or ? Math.max(12, Math.round(Math.min(or.width, or.height) * 0.03)) : 0
      exp = window.__GAME_BENCH__.screenSizeFor(mode, Math.max(1, (or ? or.width : 0) - pad * 2), Math.max(1, (or ? or.height : 0) - pad * 2), dpr)
    } catch (_) { exp = null }
    return {
      mode,
      dpr,
      w: +r.width.toFixed(3), h: +r.height.toFixed(3),
      ratio: r.height ? r.width / r.height : 0,
      kx: +(r.width * dpr / 256).toFixed(4),
      ky: +(r.height * dpr / 240).toFixed(4),
      exp,
    }
  })()`)
  const pixelPhysOk = (m) => !!m && Math.abs(m.kx - Math.round(m.kx)) < 0.02 && Math.abs(m.ky - Math.round(m.ky)) < 0.02 && Math.round(m.kx) >= 1 && Math.round(m.kx) === Math.round(m.ky)
  const pixelMeasure = await measureCanvas()
  check('默认 pixel：canvas 物理像素 256/240 整数倍（DPR 感知）',
    !!pixelMeasure && pixelMeasure.mode === 'pixel' && pixelPhysOk(pixelMeasure),
    brief(pixelMeasure && { mode: pixelMeasure.mode, dpr: pixelMeasure.dpr, w: pixelMeasure.w, h: pixelMeasure.h, kx: pixelMeasure.kx, ky: pixelMeasure.ky }))
  const cycFit = await (async () => { await evaluate(`document.querySelector('[data-gb-screen-mode]').click()`); await sleep(550); return measureCanvas() })()
  check('切到 fit：canvas 为 4:3（w/h ≈ 1.333）',
    !!cycFit && cycFit.mode === 'fit' && Math.abs(cycFit.ratio - 4 / 3) < 0.02, brief(cycFit && { mode: cycFit.mode, w: cycFit.w, h: cycFit.h, ratio: cycFit.ratio }))
  const cycStretch = await (async () => { await evaluate(`document.querySelector('[data-gb-screen-mode]').click()`); await sleep(550); return measureCanvas() })()
  check('切到 stretch：铺满可用区域（宽高 ≥ pixel/fit，比例不同于 4:3）',
    !!cycStretch && cycStretch.mode === 'stretch' && !!pixelMeasure
      && cycStretch.w >= pixelMeasure.w && cycStretch.h >= pixelMeasure.h
      && Math.abs(cycStretch.ratio - 4 / 3) > 0.02,
    brief(cycStretch && { mode: cycStretch.mode, w: cycStretch.w, h: cycStretch.h, kx: cycStretch.kx, ky: cycStretch.ky }))
  await S('02b-player-stretch.png')
  const cycPixel = await (async () => { await evaluate(`document.querySelector('[data-gb-screen-mode]').click()`); await sleep(550); return measureCanvas() })()
  check('再切回 pixel：物理像素整数倍且与初始 pixel 的整数倍一致（稳定往返）',
    !!cycPixel && cycPixel.mode === 'pixel' && pixelPhysOk(cycPixel)
      && !!pixelMeasure && Math.round(cycPixel.kx) === Math.round(pixelMeasure.kx),
    brief({ now: cycPixel && { kx: cycPixel.kx, ky: cycPixel.ky }, before: pixelMeasure && { kx: pixelMeasure.kx, ky: pixelMeasure.ky } }))
  await S('02c-player-pixel.png')
  check('画面模式按钮 aria-label/title 反映当前模式（4:3 比例/铺满/像素）',
    await evaluate(`(() => {
      const b = document.querySelector('[data-gb-screen-mode]')
      if (!b) return false
      const text = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')
      const mode = b.getAttribute('data-gb-screen-mode')
      const map = { fit: /4:3|比例|fit/i, stretch: /铺满|stretch|拉伸/i, pixel: /像素|pixel/i }
      return !!(map[mode] && map[mode].test(text))
    })()`))

  // 全屏：优先真实 CDP 手势（headless 可能无用户激活），失败则注入 fullscreen 状态验证结构
  const fsBtn = await evaluate(`(() => {
    const b = document.querySelector('[data-gb-fullscreen]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  let realFs = false
  if (fsBtn) {
    try {
      // 控制条可能已自动隐藏（pointer-events:none）→ 先把指针移到控制条区域唤出，再用真实手势点全屏
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fsBtn.x, y: fsBtn.y, button: 'none', pointerType: 'mouse' })
      await sleep(500)
      const barReady = await evaluate(`(() => { const b = document.querySelector('.gb-player-bar'); return !!b && Number(getComputedStyle(b).opacity) > 0.8 && getComputedStyle(b).pointerEvents !== 'none' })()`)
      if (!barReady) console.log('  · 全屏前控制条未就绪（opacity/pointer-events），仍尝试点击')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fsBtn.x, y: fsBtn.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fsBtn.x, y: fsBtn.y, button: 'left', clickCount: 1 })
      await sleep(900)
      realFs = await evaluate(`!!document.fullscreenElement`)
    } catch (_) { realFs = false }
  }
  if (realFs) {
    check('真实全屏：requestFullscreen 生效（document.fullscreenElement）', true)
    await S('02d-player-fullscreen.png')
    await evaluate(`(document.exitFullscreen ? document.exitFullscreen() : Promise.resolve())`)
    await sleep(500)
  } else {
    console.log('  · headless 无用户激活，requestFullscreen 未生效 → 用 store 注入 fullscreen 状态验证「控制条闲置隐藏」结构')
    await evaluate(`window.__GAME_BENCH__.setState({ fullscreen: true })`)
    const vwC = await evaluate('Math.round(window.innerWidth / 2)')
    const vhC = await evaluate('Math.round(window.innerHeight / 2)')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vwC, y: vhC, button: 'none', pointerType: 'mouse' })
    await sleep(3000)
    const hidden = await evaluate(`!!document.querySelector('.gb-player.is-controls-hidden')`)
    await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))`)
    await sleep(400)
    const restored = await evaluate(`!document.querySelector('.gb-player.is-controls-hidden')`)
    check('全屏闲置 2.5s 后控制条自动隐藏（is-controls-hidden），指针移动后恢复', hidden && restored, { hidden, restored })
    await evaluate(`window.__GAME_BENCH__.setState({ fullscreen: false })`)
    await sleep(300)
  }

  // CRT 滤镜：默认关闭（面板反馈「受损感」后默认 crt=false），点击开启后才出现覆盖层
  const crtOff = await evaluate(`!document.querySelector('[data-gb-crt]') && !document.querySelector('.gb-player.is-crt')`)
  check('默认关闭 CRT 滤镜（无 [data-gb-crt] 覆盖层）', crtOff === true)
  await evaluate(`(document.querySelector('[data-gb-crt-toggle]') || { click() {} }).click()`)
  await sleep(500)
  const crtOn = await evaluate(`!!document.querySelector('[data-gb-crt]') && !!document.querySelector('.gb-player.is-crt')`)
  check('点击 CRT 开关：出现覆盖层 + 播放器 is-crt', crtOn === true)
  await S('02e-player-crt.png')
  await evaluate(`(document.querySelector('[data-gb-crt-toggle]') || { click() {} }).click()`)
  await sleep(400)
  check('再点关闭 CRT：覆盖层移除', await evaluate(`!document.querySelector('[data-gb-crt]')`))

  /* ================================================================ *
   * [3b] 内置 7 款 ROM：真实 engine 逐个加载 + 渲染 + 存档往返
   * ================================================================ */
  section(`[3b] 内置 ${expectedBuiltinCount} 款 ROM（engine 真实运行）`)
  const romResults = await evaluate(`(async () => {
    const lib = await (await fetch('/game-bench/api/library')).json()
    const games = (lib.data.games || []).filter((g) => g.builtin)
    const out = []
    for (const g of games) {
      const canvas = document.createElement('canvas')
      let eng = null
      try {
        eng = window.GameBenchCore.create({ canvas, volume: 0 })
        const bytes = new Uint8Array(await (await fetch(g.rom)).arrayBuffer())
        eng.loadRom(bytes)
        eng.start()
        /* 引擎启动到首帧渲染有 ~0.9s 的音频初始化延迟，标题画面也可能短暂全黑；采样到 2.4s 取峰值 */
        let nonBlack = 0
        const c = canvas.getContext('2d')
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 350))
          const d = c.getImageData(0, 0, canvas.width, canvas.height).data
          let n = 0
          for (let j = 0; j < d.length; j += 4) if ((d[j] | (d[j + 1] << 8) | (d[j + 2] << 16)) !== 0) n++
          if (n > nonBlack) nonBlack = n
          if (nonBlack > 500) break
        }
        out.push({ title: g.title, size: bytes.length, cw: canvas.width, ch: canvas.height, nonBlack })
        eng.destroy()
      } catch (e) {
        out.push({ title: g.title, error: String((e && e.message) || e) })
        try { eng && eng.destroy() } catch (_) { /* ignore */ }
      }
    }
    return out
  })()`)
  const romFails = romResults.filter((r) => r.error || r.nonBlack <= 300 || r.cw !== 256 || r.ch !== 240)
  check(`全部 ${expectedBuiltinCount} 款内置 ROM 加载并渲染出非黑画面（256×240，非黑像素 > 300）`,
    romResults.length === expectedBuiltinCount && expectedBuiltinCount >= 1 && romFails.length === 0,
    brief({ count: romResults.length, expected: expectedBuiltinCount, fails: romFails, sample: romResults.slice(0, 3) }))
  let engineRoundtrip = null
  try {
    engineRoundtrip = await evaluate(`(async () => {
    const lib = await (await fetch('/game-bench/api/library')).json()
    const g = (lib.data.games || [])[0]
    const canvas = document.createElement('canvas')
    const eng = window.GameBenchCore.create({ canvas, volume: 0 })
    try {
      const bytes = new Uint8Array(await (await fetch(g.rom)).arrayBuffer())
      eng.loadRom(bytes)
      eng.start()
      await new Promise((r) => setTimeout(r, 1000))
      const state = await eng.saveState()
      const len = state && state.byteLength ? state.byteLength : 0
      const magic = state && state.length >= 2 ? [state[0], state[1]] : []
      eng.reset()
      await eng.loadState(state)
      await new Promise((r) => setTimeout(r, 900))
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let nonBlack = 0
      for (let i = 0; i < d.length; i += 4) if ((d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) !== 0) nonBlack++
      eng.destroy()
      return { len, magic, nonBlack, ok: true }
    } catch (e) {
      try { eng.destroy() } catch (_) { /* ignore */ }
      return { ok: false, error: String((e && e.message) || e) }
    }
  })()`)
  } catch (err) {
    engineRoundtrip = { ok: false, error: String((err && err.message) || err) }
  }
  check('engine saveState → loadState 往返（gzip 状态 > 1000B，读档不抛错且画面恢复）',
    !!engineRoundtrip && engineRoundtrip.ok === true && engineRoundtrip.len > 1000 && engineRoundtrip.nonBlack > 500,
    brief(engineRoundtrip))
  check('存档为 gzip 压缩（魔数 1f 8b）', !!engineRoundtrip && Array.isArray(engineRoundtrip.magic) && engineRoundtrip.magic[0] === 0x1f && engineRoundtrip.magic[1] === 0x8b, brief(engineRoundtrip && engineRoundtrip.magic))

  /* ================================================================ *
   * [4] 键盘输入 / 不抢键
   * ================================================================ */
  section('[4] 键盘（引擎接收 + 不抢键）')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 760, button: 'none', pointerType: 'mouse' })
  await sleep(350)
  const beforeKeys = await evaluate('window.__gbEngines.length ? window.__gbEngines[0].setButton.length : 0')
  await evaluate('window.__gbFocus(\'[data-gb="root"] canvas\')')
  await evaluate('window.__gbKey("ArrowRight", "ArrowRight")')
  await sleep(300)
  await evaluate('window.__gbKey("z", "KeyZ")')
  await evaluate('window.__gbKey("Enter", "Enter")')
  await sleep(400)
  const afterKeys = await evaluate('(() => { const e = window.__gbEngines[0]; return e ? { buttons: e.setButton.slice(-14), total: e.setButton.length } : null })()')
  const accepted = !!afterKeys && afterKeys.total > beforeKeys
  check('键盘事件被 engine 接收（ArrowRight/Z → setButton 调用）', accepted, brief(afterKeys && afterKeys.buttons))
  check('按键有按下也有抬起（无卡键）', !!afterKeys && afterKeys.buttons.some((b) => b.down) && afterKeys.buttons.some((b) => !b.down), brief(afterKeys && afterKeys.buttons))
  // 部分 ROM（如公开 demo 的静止画面）按键后像素可能不变，用 engine 帧计数兜底
  const framesAtKeyStart = await evaluate('(() => { const e = window.__gbEngines[0]; return e && e.lastState ? e.lastState.frames : null })()')
  let keyHashChanged = false
  let lastHash = (await canvasStats() || {}).hash
  for (let i = 0; i < 4 && !keyHashChanged; i++) {
    await sleep(300)
    const sample = await canvasStats()
    if (sample && lastHash != null && sample.hash !== lastHash) keyHashChanged = true
    lastHash = sample && sample.hash
  }
  const framesAtKeyEnd = await evaluate('(() => { const e = window.__gbEngines[0]; return e && e.lastState ? e.lastState.frames : null })()')
  const keyFramesGrew = typeof framesAtKeyStart === 'number' && typeof framesAtKeyEnd === 'number' ? framesAtKeyEnd > framesAtKeyStart : false
  check('按键后引擎仍在推进（帧计数递增 或 画面变化）', keyFramesGrew || keyHashChanged,
    brief({ frames: `${framesAtKeyStart} → ${framesAtKeyEnd}`, keyHashChanged }))
  await S('03-keyboard.png')

  // 对话输入框：真实按键不能进 engine，也不能 preventDefault
  const focusedConv = await evaluate('window.__gbFocus("#conv-input")')
  check('聚焦对话输入框 #conv-input', focusedConv === true)
  const keyBefore = await evaluate('window.__gbEngines.length ? window.__gbEngines[0].setButton.length : 0')
  const convKey = await evaluate('window.__gbKey("ArrowRight", "ArrowRight", "#conv-input")')
  check('输入框内 ArrowRight 未被 preventDefault', !!convKey && convKey.prevented === false && convKey.defaultPrevented === false, brief(convKey))
  await sleep(300)
  const convForwarded = await evaluate(`(() => {
    const e = window.__gbEngines[0]
    if (!e) return []
    return e.setButton.slice(${keyBefore}).filter((b) => b.name === 'RIGHT')
  })()`)
  check('输入框里按键不转发给 engine（不抢键）', convForwarded.length === 0, brief(convForwarded))
  // 真实打字：CDP 输入法文本
  await evaluate('window.__gbFocus("#conv-input")')
  await cdp.send('Input.insertText', { text: 'hello' })
  await sleep(250)
  const convValue = await evaluate('document.querySelector("#conv-input").value')
  check('对话输入框真实打字内容正确', convValue === 'hello', brief(convValue))

  /* ================================================================ *
   * [5] 存档：IndexedDB（存档 → 槽位面板 → 槽位 1 → 重置 → 读档）
   * ================================================================ */
  section('[5] 存档（IndexedDB）')
  const saveHit = await clickFirst(['[data-gb-save]', '[data-gb-save-1]'], /存档|保存|save/i)
  check('点击存档按钮', !!saveHit, brief(saveHit))
  await sleep(500)
  const savePanelOpen = await evaluate(`!!document.querySelector('[data-gb-save-panel="save"]')`)
  let slot1Clicked = false
  if (savePanelOpen) {
    slot1Clicked = !!(await clickFirst(
      ['[data-gb-save-panel="save"] [data-gb-save-slot="1"]', '[data-gb-save-slot="1"]'],
      /存档 ?1|槽位 ?1|存档$|save/i,
    ))
  }
  check('打开存档面板并写入槽位 1', savePanelOpen ? slot1Clicked : false, brief({ savePanelOpen, slot1Clicked }))
  let idb1 = { keys: [], meta: [] }
  try {
    await waitUntil(async () => {
      idb1 = await evaluate('window.__gbIdb()')
      return (idb1.keys || []).some((k) => /#1$/.test(k.key))
    }, 'idb save slot 1', 10000)
  } catch (err) { /* 断言报告 */ }
  const saveKeys = (idb1.keys || []).filter((k) => /save/i.test(k.store) || /#/.test(k.key))
  const slot1 = saveKeys.find((k) => /#1$/.test(k.key))
  check('IndexedDB 出现存档记录（saves）', saveKeys.length > 0, brief(saveKeys.slice(0, 6)))
  check('存档 key 形如 <gameId>#1', !!slot1 && (!playedId || slot1.key === `${playedId}#1`), brief({ playedId, keys: saveKeys.map((k) => k.key).slice(0, 8) }))
  const saveMeta = (idb1.meta || []).find((m) => (m.stateBytes || m.bytes) > 0)
  check('存档内容非空（state 字节数 > 1000）', !!saveMeta && (saveMeta.stateBytes || saveMeta.bytes) > 1000, brief(saveMeta))
  await S('05-save.png')

  // 重置 → 读档
  const resetHit = await clickFirst(['[data-gb-reset]'], /重置|复位|重启|reset/i)
  check('点击重置', !!resetHit, brief(resetHit))
  await sleep(700)
  const afterReset = await canvasStats()
  const loadHit = await clickFirst(['[data-gb-load]', '[data-gb-load-1]'], /读档|载入|读取|load/i)
  check('点击读档按钮', !!loadHit, brief(loadHit))
  await sleep(500)
  const loadPanelOpen = await evaluate(`!!document.querySelector('[data-gb-save-panel="load"]')`)
  let slotLoaded = false
  if (loadPanelOpen) {
    slotLoaded = !!(await clickFirst(['[data-gb-save-panel="load"] [data-gb-load-slot="1"]', '[data-gb-load-slot="1"]'], /读取|读档|load/i))
  }
  check('读档面板选择槽位 1', loadPanelOpen ? slotLoaded : true, brief({ loadPanelOpen, slotLoaded }))
  await sleep(1000)
  let restored = false
  try {
    await waitFor(`(() => { const s = window.__gbCanvasStats(); return s && s.nonBlack > 500 })()`, 'canvas after load', 8000)
    restored = true
  } catch (err) { /* 断言报告 */ }
  const afterLoad = await canvasStats()
  check('读档后画面恢复（canvas 仍非全黑）', restored, brief({ afterReset: afterReset && afterReset.nonBlack, afterLoad: afterLoad && afterLoad.nonBlack }))
  const toastLoad = await evaluate(`(() => { const el = document.querySelector('[data-gb-toast]'); return el ? (el.textContent || '').trim() : '' })()`)
  check('读档有可读反馈（toast/状态文字）', /读档|已读取|载入|恢复|load/i.test(toastLoad) || restored, brief(toastLoad))
  await S('06-load-restored.png')

  /* ================================================================ *
   * [5b] 控制条自动隐藏（窗口 / 全屏）—— 新增契约（Lead 实现中）
   *   DOM: [data-gb-player][data-gb-controls="hidden|visible"]
   *   规则：2.5s 无操作隐藏（窗口 + 全屏都一样）；鼠标进入底部 100px / 顶部 48px
   *   pointermove 唤出；触屏 pointerdown 唤出；游戏 keydown 不唤出；
   *   暂停 / 存档面板打开时保持可见；rAF 游戏在隐藏期间继续跑；
   *   隐藏时控制条实际 opacity≈0 且 pointer-events:none；退出播放器无残留监听。
   * ================================================================ */
  section('[5b] 控制条自动隐藏（窗口 / 全屏）')
  const playerRect = () => evaluate(`(() => {
    const p = document.querySelector('[data-gb-player]')
    const r = p ? p.getBoundingClientRect() : null
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } : null
  })()`)
  const controlsState = () => evaluate(`(() => {
    const player = document.querySelector('[data-gb-player]')
    const anchor = document.querySelector('[data-gb-pause]') || document.querySelector('[data-gb-screen-mode]') || document.querySelector('[data-gb-save]')
    const barEl = document.querySelector('[data-gb-player] .gb-player-bar')
      || (anchor && anchor.closest('.gb-player-bar, .gb-controls, .gb-player-controls'))
      || (anchor && anchor.parentElement)
    const bar = barEl ? (() => {
      const cs = getComputedStyle(barEl)
      const r = barEl.getBoundingClientRect()
      return { opacity: Number(cs.opacity), pointerEvents: cs.pointerEvents, position: cs.position, visibility: cs.visibility, cls: String(barEl.className || '').slice(0, 70), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
    })() : null
    const stage = document.querySelector('[data-gb-stage]')
    const sr = stage ? stage.getBoundingClientRect() : null
    const outer = document.querySelector('[data-gb-player] .gb-player-stage') || (stage && stage.parentElement)
    const osr = outer ? outer.getBoundingClientRect() : null
    return {
      attr: player ? player.getAttribute('data-gb-controls') : null,
      hasPlayer: !!player,
      bar,
      stage: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom), h: Math.round(sr.height) } : null,
      outerStage: osr ? { top: Math.round(osr.top), bottom: Math.round(osr.bottom), h: Math.round(osr.height) } : null,
    }
  })()`)
  const framesNow = () => evaluate('(() => { const e = window.__gbEngines[0]; return e && e.lastState ? e.lastState.frames : null })()')
  const pointerReveal = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', pointerType: 'mouse' })
  const hiddenOk = (st) => !!st && st.attr === 'hidden' && !!st.bar && st.bar.opacity <= 0.06 && st.bar.pointerEvents === 'none'
  const visibleOk = (st) => !!st && st.attr === 'visible' && !!st.bar && st.bar.opacity >= 0.85 && st.bar.pointerEvents !== 'none'

  const hasPlayerHook = await evaluate(`!!document.querySelector('[data-gb-player]')`)
  check('播放器根节点 [data-gb-player] 存在（控制条状态挂在它上面）', hasPlayerHook === true)
  let pr = await playerRect()
  await pointerReveal(pr ? pr.cx : 720, pr ? pr.cy : 400)
  await sleep(450)
  const vis0 = await controlsState()
  check('初始控制条可见（data-gb-controls="visible"，opacity≈1）', visibleOk(vis0), brief(vis0))
  const visStage = vis0.stage
  const visBar = vis0.bar

  // 1) 窗口内闲置 >2.5s → hidden
  await pointerReveal(pr ? pr.cx : 720, pr ? pr.cy : 400)
  await sleep(2900)
  const hid1 = await controlsState()
  check('窗口内闲置 >2.5s：data-gb-controls="hidden"', hid1.attr === 'hidden', brief({ attr: hid1.attr, bar: hid1.bar }))
  check('隐藏是真的：控制条 opacity≈0 且 pointer-events:none',
    !!hid1.bar && hid1.bar.opacity <= 0.06 && hid1.bar.pointerEvents === 'none', brief(hid1.bar))
  check('控制条为浮层：隐藏前后舞台高度不变（不因显隐 reflow）',
    !!hid1.stage && !!visStage && Math.abs(hid1.stage.h - visStage.h) <= 2, brief({ visible: visStage, hidden: hid1.stage }))
  check('控制条浮在舞台之上（bar 与 .gb-player-stage 区域重叠；pixel 模式下屏幕画框小于 stage）',
    !!hid1.bar && !!hid1.outerStage && hid1.bar.top >= hid1.outerStage.top - 2 && hid1.bar.top < hid1.outerStage.bottom,
    brief({ bar: hid1.bar && { top: hid1.bar.top, h: hid1.bar.h }, outerStage: hid1.outerStage, screenFrame: hid1.stage }))
  await S('02f-controls-hidden.png')

  // 2) 隐藏期间 rAF 继续
  const f1 = await framesNow()
  await sleep(1400)
  const f2 = await framesNow()
  check('隐藏期间游戏仍在跑（engine frames 递增）',
    typeof f1 === 'number' && typeof f2 === 'number' && f2 > f1, brief({ f1, f2 }))

  // 3) 游戏 keydown 不唤出
  await evaluate('window.__gbKey("ArrowRight", "ArrowRight")')
  await sleep(600)
  check('游戏 keydown 不唤出控制条（仍 hidden）', (await controlsState()).attr === 'hidden')

  // 4) 底部 100px pointermove 唤出
  pr = await playerRect()
  await pointerReveal(pr ? pr.cx : 700, pr ? pr.y + pr.h - 20 : 800)
  await sleep(600)
  const visBottom = await controlsState()
  check('鼠标移入舞台底部 100px：控制条唤出', visibleOk(visBottom), brief({ attr: visBottom.attr, bar: visBottom.bar && { opacity: visBottom.bar.opacity } }))
  await S('02g-controls-visible.png')

  // 5) 顶部 48px pointermove 唤出（先移到画面中央、再次闲置隐藏——停在底部会 hover 住控制条导致永不隐藏）
  await pointerReveal(pr ? pr.cx : 700, pr ? pr.y + Math.round(pr.h / 2) : 400)
  await sleep(2900)
  check('再次闲置 → hidden（顶部唤出前置条件）', (await controlsState()).attr === 'hidden')
  await pointerReveal(pr ? pr.cx : 700, pr ? pr.y + 16 : 20)
  await sleep(600)
  check('鼠标移入舞台顶部 48px：控制条唤出', (await controlsState()).attr === 'visible')
  await pointerReveal(pr ? pr.cx : 700, pr ? pr.y + Math.round(pr.h / 2) : 400)

  // 6) 触屏 pointerdown 唤出（先闲置隐藏）
  await sleep(2900)
  check('再次闲置 → hidden（触屏唤出前置条件）', (await controlsState()).attr === 'hidden')
  const touchReveal = await (async () => {
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      const p2 = await playerRect()
      const x = p2 ? p2.cx : 700
      const y = p2 ? p2.cy : 400
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] })
      await sleep(150)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(600)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      return { ok: (await controlsState()).attr === 'visible', method: 'cdp-touch' }
    } catch (err) {
      try { await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }) } catch (_) { /* ignore */ }
      const ok = await evaluate(`(() => {
        const t = document.querySelector('[data-gb-stage]') || document.querySelector('[data-gb-player]') || document.body
        t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }))
        return true
      })()`)
      await sleep(600)
      return { ok: ok && (await controlsState()).attr === 'visible', method: 'synthetic-pointer' }
    }
  })()
  check('触屏 pointerdown 唤出控制条（touchStart / pointerType=touch）', touchReveal.ok === true, brief(touchReveal))

  // 7) 暂停时保持可见（闲置 >2.5s 仍 visible）
  await evaluate(`(document.querySelector('[data-gb-pause]') || { click() {} }).click()`)
  await sleep(500)
  await pointerReveal(pr ? pr.cx : 700, pr ? pr.cy : 400)
  await sleep(2900)
  check('暂停时控制条常显（闲置 >2.5s 仍 visible）', (await controlsState()).attr === 'visible')
  await evaluate(`(document.querySelector('[data-gb-pause]') || { click() {} }).click()`)
  await sleep(600)

  // 8) 存档面板打开时保持可见
  await evaluate(`(document.querySelector('[data-gb-save]') || { click() {} }).click()`)
  await sleep(700)
  const panelOpen = await evaluate(`!!document.querySelector('[data-gb-save-panel]')`)
  await sleep(2900)
  check('存档面板打开时控制条常显（闲置 >2.5s 仍 visible）',
    panelOpen === true && (await controlsState()).attr === 'visible', brief({ panelOpen }))
  // 关闭面板（按钮/Escape 兜底）
  await evaluate(`(() => {
    const p = document.querySelector('[data-gb-save-panel]')
    if (!p) return false
    const close = p.querySelector('.gb-saves-head button') || p.querySelector('button[aria-label*="关闭"]') || p.querySelector('button')
    if (close) { close.click(); return true }
    return false
  })()`)
  await sleep(600)

  // 9) 全屏：同样 2.5s 隐藏 + 底部唤出（真实 CDP 手势进入全屏）
  const fsBtnControls = await evaluate(`(() => {
    const b = document.querySelector('[data-gb-fullscreen]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  let fsForControls = false
  if (fsBtnControls) {
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fsBtnControls.x, y: fsBtnControls.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fsBtnControls.x, y: fsBtnControls.y, button: 'left', clickCount: 1 })
      await sleep(900)
      fsForControls = await evaluate(`!!document.fullscreenElement`)
    } catch (_) { fsForControls = false }
  }
  if (fsForControls) {
    const vwCenter = await evaluate('Math.round(window.innerWidth / 2)')
    const vhCenter = await evaluate('Math.round(window.innerHeight / 2)')
    await pointerReveal(vwCenter, vhCenter)
    await sleep(2900)
    const fsHidden = await controlsState()
    check('全屏闲置 >2.5s：控制条 hidden', fsHidden.attr === 'hidden' && hiddenOk(fsHidden), brief({ attr: fsHidden.attr, bar: fsHidden.bar }))
    await S('02h-fullscreen-hidden.png')
    const ffs1 = await framesNow()
    await sleep(1200)
    const ffs2 = await framesNow()
    check('全屏隐藏期间游戏仍在跑（frames 递增）', typeof ffs1 === 'number' && typeof ffs2 === 'number' && ffs2 > ffs1, brief({ ffs1, ffs2 }))
    const vw = await evaluate('window.innerWidth')
    const vh = await evaluate('window.innerHeight')
    await pointerReveal(vw / 2, vh - 20)
    await sleep(700)
    check('全屏鼠标移到底部 100px：控制条唤出', (await controlsState()).attr === 'visible')
    await evaluate(`(document.exitFullscreen ? document.exitFullscreen() : Promise.resolve())`)
    await sleep(800)
  } else {
    console.log('  · 未能进入全屏（headless 无用户激活）→ 全屏控制条隐藏用例 SKIP（窗口内已覆盖）')
  }

  // 10) 退出播放器：无残留监听
  //   注意：自动隐藏监听绑在 player 元素上（Lead 确认），所以同时统计 window / document / player 元素三类目标。
  //   先退出当前播放器（清掉进入 spy 前已绑定的监听），再装 spy，重进→开始→退出统计净增。
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(900)
  await evaluate(`(() => {
    if (window.__gbListenerSpy) return true
    const types = ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'keyup', 'wheel', 'pointerup', 'mousemove', 'contextmenu']
    const net = new Map()
    const origAdd = EventTarget.prototype.addEventListener
    const origRemove = EventTarget.prototype.removeEventListener
    const tag = (target) => {
      if (target === window) return 'window'
      if (target === document) return 'document'
      if (target && target.nodeType === 1 && target.closest && target.closest('[data-gb-player]')) return 'player'
      return ''
    }
    const bump = (target, type, delta) => {
      if (types.indexOf(type) < 0) return
      const kind = tag(target)
      if (!kind) return
      let rec = net.get(target)
      if (!rec) { rec = { kind, counts: {} }; net.set(target, rec) }
      rec.counts[type] = (rec.counts[type] || 0) + delta
    }
    EventTarget.prototype.addEventListener = function (type, fn, opts) { bump(this, type, 1); return origAdd.call(this, type, fn, opts) }
    EventTarget.prototype.removeEventListener = function (type, fn, opts) { bump(this, type, -1); return origRemove.call(this, type, fn, opts) }
    window.__gbListenerSpy = {
      restore() { EventTarget.prototype.addEventListener = origAdd; EventTarget.prototype.removeEventListener = origRemove },
      summary() {
        const out = { window: 0, document: 0, playerNet: 0, playerDetached: true, byTarget: [] }
        net.forEach((rec, target) => {
          const total = Object.keys(rec.counts).reduce((a, k) => a + rec.counts[k], 0)
          if (rec.kind === 'window') out.window += total
          else if (rec.kind === 'document') out.document += total
          else {
            out.playerNet += total
            out.byTarget.push({ total, connected: !!target.isConnected, counts: rec.counts })
          }
        })
        out.playerDetached = out.byTarget.every((x) => x.connected === false || x.total === 0)
        return out
      },
    }
    return true
  })()`)
  // 重进 → 开始 → 退出
  const reenter = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-gb-card]')]
    const card = cards.find((c) => /超级玛丽|魂斗罗/.test(c.textContent || '')) || cards[0]
    if (!card) return false
    ;(card.querySelector('.gb-card-hit') || card.querySelector('button') || card).click()
    return true
  })()`)
  check('退出后可再次进入播放器（重新绑定监听）', reenter === true)
  await sleep(1200)
  await startPlayer('reenter start')
  await sleep(1500)
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(1100)
  const spySummary = await evaluate('window.__gbListenerSpy.summary()')
  check('退出播放器后 window 监听净增 = 0', spySummary.window === 0, brief(spySummary.byTarget))
  check('退出播放器后 document 监听净增 = 0', spySummary.document === 0, brief(spySummary.byTarget))
  check('player 元素上的监听已清理或随元素移除（无残留）',
    spySummary.playerNet === 0 || spySummary.playerDetached === true,
    brief({ playerNet: spySummary.playerNet, byTarget: spySummary.byTarget }))
  await evaluate('window.__gbListenerSpy.restore()')
  check('退出后 [data-gb-player] 已移除', await evaluate(`!document.querySelector('[data-gb-player]')`))
  check('退出后引擎已销毁（__GAME_BENCH__.getEngine() 为空）',
    await evaluate(`(() => { try { const e = window.__GAME_BENCH__ && window.__GAME_BENCH__.getEngine && window.__GAME_BENCH__.getEngine(); return !e } catch (_) { return true } })()`))

  /* ================================================================ *
   * [5c] 库卡右键菜单（Lead 新钩子）
   *   卡 [data-gb-card=id]、按钮 [data-gb-menu=id]、菜单 [data-gb-launch-menu=id]、
   *   [data-gb-restart=id]、[data-gb-resume-slot=auto|1|2|3]、空态 [data-gb-no-saves]
   *   右键 onContextMenu 固定菜单；点外部/Esc 关闭；click 仍直接启动；
   *   playGame(game, slot) → startSlot → bootPlayer loadRom 后 readSave + await loadState；
   *   菜单 savedSlots 的 updatedAt/timeText 要与 IndexedDB 实际记录一致。
   * ================================================================ */
  section('[5c] 库卡右键菜单（重新开始 / 从存档继续 / 空态）')
  await gotoTab('library')
  await sleep(500)
  const menuCards = await evaluate(`[...document.querySelectorAll('[data-gb-card]')].map((c) => ({
    id: c.getAttribute('data-gb-card'),
    menuBtn: !!c.querySelector('[data-gb-menu]'),
    title: (c.textContent || '').trim().slice(0, 40),
  }))`)
  check('每张库卡（含内置）都有 [data-gb-menu] 菜单按钮',
    menuCards.length > 0 && menuCards.every((c) => c.menuBtn === true), brief(menuCards.slice(0, 3)))
  const playedCard = menuCards.find((c) => /超级玛丽/.test(c.title)) || menuCards[0]
  const idbAll = await evaluate('window.__gbIdb()')
  const idbSaves = (idbAll.meta || [])
    .filter((m) => m.store === 'saves' && m.gameId === playedCard.id)
    .map((m) => ({ slot: String(m.slot), updatedAt: Number(m.updatedAt) || 0, bytes: m.stateBytes || m.bytes || 0 }))
  const savedGameIds = new Set((idbAll.meta || []).filter((m) => m.store === 'saves' && m.gameId).map((m) => m.gameId))
  const noSaveCard = menuCards.find((c) => c.id !== playedCard.id && !savedGameIds.has(c.id)) || null
  console.log(`  · 右键目标：${playedCard.title}（IDB 存档 ${idbSaves.length} 个：${idbSaves.map((s) => s.slot).join(',') || '无'}）`)

  const menuInfo = (gameId) => evaluate(`(() => {
    const menus = [...document.querySelectorAll('[data-gb-launch-menu]')]
    const menu = menus.find((m) => m.getAttribute('data-gb-launch-menu') === ${JSON.stringify(gameId)}) || menus[0] || null
    const r = menu ? menu.getBoundingClientRect() : null
    const cs = menu ? getComputedStyle(menu) : null
    const resumes = menu ? [...menu.querySelectorAll('[data-gb-resume-slot]')].map((el) => ({
      slot: el.getAttribute('data-gb-resume-slot'),
      text: (el.textContent || '').trim(),
      small: el.querySelector('small') ? (el.querySelector('small').textContent || '').trim() : '',
      role: el.getAttribute('role'),
    })) : []
    return {
      exists: !!menu,
      total: menus.length,
      id: menu ? menu.getAttribute('data-gb-launch-menu') : null,
      position: cs ? cs.position : null,
      rect: r ? { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
      restart: menu ? !!menu.querySelector('[data-gb-restart]') : false,
      noSaves: menu ? !!menu.querySelector('[data-gb-no-saves]') : false,
      resumes,
      role: menu ? menu.getAttribute('role') : null,
      itemRoles: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.getAttribute('role')) : [],
      rootView: (() => { const root = document.querySelector('[data-gb="root"]'); return root ? root.getAttribute('data-gb-view') : null })(),
      player: !!document.querySelector('[data-gb-player]'),
    }
  })()`)
  const cardPoint = (id) => evaluate(`(() => {
    const c = document.querySelector('[data-gb-card="${id}"]')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { cx: Math.round(r.left + Math.min(r.width / 2, 70)), cy: Math.round(r.top + Math.min(r.height / 2, 60)) }
  })()`)
  const rightClick = async (id) => {
    const pt = await cardPoint(id)
    if (!pt) return null
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.cx, y: pt.cy, button: 'right', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.cx, y: pt.cy, button: 'right', clickCount: 1 })
    await sleep(450)
    let info = await menuInfo(id)
    if (!info.exists) {
      // 兜底：合成 contextmenu（headless 组合下偶尔不派发原生 contextmenu）
      await evaluate(`(() => {
        const c = document.querySelector('[data-gb-card="${id}"]')
        if (!c) return false
        const r = c.getBoundingClientRect()
        c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) }))
        return true
      })()`)
      await sleep(450)
      info = await menuInfo(id)
    }
    return { pt, info }
  }
  const closeMenu = async () => {
    await evaluate('window.__gbKey("Escape", "Escape")')
    await sleep(400)
    return evaluate(`document.querySelectorAll('[data-gb-launch-menu]').length === 0`)
  }
  const waitMenuLoaded = async (gameId, timeout = 3000) => {
    try {
      await waitFor(`(() => {
        const m = document.querySelector('[data-gb-launch-menu="${gameId}"]')
        if (!m) return false
        return !!m.querySelector('[data-gb-no-saves], [data-gb-resume-slot]')
      })()`, 'menu saved slots loaded', timeout)
      return true
    } catch (err) { return false }
  }

  // 1) 右键：固定菜单出现在光标处，且不启动游戏
  const rc1 = await rightClick(playedCard.id)
  await waitMenuLoaded(playedCard.id)
  rc1.info = await menuInfo(playedCard.id)
  check('右键卡片：出现 [data-gb-launch-menu]（id 对应）且同一时刻只有一个',
    !!rc1 && rc1.info.exists && rc1.info.id === playedCard.id && rc1.info.total === 1, brief(rc1 && rc1.info))
  check('右键菜单为 fixed 定位且贴着光标（不超出视口）',
    !!rc1 && rc1.info.position === 'fixed' && !!rc1.info.rect && rc1.info.rect.left >= 8 && rc1.info.rect.top >= 8, brief(rc1 && { position: rc1.info.position, rect: rc1.info.rect, pt: rc1.pt }))
  check('右键不启动游戏（仍在 library、无 [data-gb-player]）',
    !!rc1 && rc1.info.rootView === 'library' && rc1.info.player === false, brief({ view: rc1 && rc1.info.rootView, player: rc1 && rc1.info.player }))
  check('菜单含「重新开始」[data-gb-restart] 与 role=menu/menuitem',
    !!rc1 && rc1.info.restart === true && rc1.info.role === 'menu' && (rc1.info.itemRoles || []).every((r) => r === 'menuitem'), brief(rc1 && { restart: rc1.info.restart, role: rc1.info.role }))
  await S('02i-menu-context.png')

  // 2) savedSlots 与 IndexedDB 一致（slot 集合、updatedAt→timeText、排序）
  const timeTextFor = async (ts) => evaluate(`(() => {
    const d = new Date(${JSON.stringify(Number(ts) || 0)})
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  })()`)
  const resumeItems = (rc1 && rc1.info.resumes) || []
  const expectedSlots = idbSaves.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.slot)
  check('菜单 savedSlots 的槽位集合与 IndexedDB 一致（含 auto）',
    JSON.stringify(resumeItems.map((r) => r.slot)) === JSON.stringify(expectedSlots),
    brief({ menu: resumeItems.map((r) => r.slot), idb: expectedSlots }))
  let timeOk = resumeItems.length > 0
  const timeDetails = []
  for (const item of resumeItems) {
    const rec = idbSaves.find((s) => s.slot === item.slot)
    const expected = rec ? await timeTextFor(rec.updatedAt) : ''
    const ok = !!rec && item.small === expected
    if (!ok) timeOk = false
    timeDetails.push({ slot: item.slot, menu: item.small, idb: rec && rec.updatedAt, expected, ok })
  }
  check('菜单存档时间文本 = timeText(updatedAt)（MM-DD HH:mm，与 IDB 一致）',
    timeOk, brief(timeDetails))
  check('有多条存档时按 updatedAt 倒序（最新在前）',
    idbSaves.length < 2 || (() => {
      const times = resumeItems.map((item) => (idbSaves.find((s) => s.slot === item.slot) || {}).updatedAt || 0)
      return times.every((t, i) => i === 0 || times[i - 1] >= t)
    })(), brief({ menu: resumeItems.map((r) => r.slot), idb: expectedSlots }))
  if (idbSaves.length === 0) {
    check('无存档时菜单显示 [data-gb-no-saves] 空态', rc1 && rc1.info.noSaves === true)
  }

  // 3) Esc 关闭 / 点外部关闭
  check('Esc 关闭右键菜单', (await closeMenu()) === true)
  const rc2 = await rightClick(playedCard.id)
  check('再次右键可重新打开菜单', !!rc2 && rc2.info.exists === true)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1100, y: 90, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1100, y: 90, button: 'left', clickCount: 1 })
  await sleep(450)
  check('点菜单外部关闭右键菜单', (await evaluate(`document.querySelectorAll('[data-gb-launch-menu]').length === 0`)) === true)

  // 4) 菜单按钮（非右键）打开/关闭，且为卡内绝对定位
  const toggleOpen = await evaluate(`(() => { const b = document.querySelector('[data-gb-card="${playedCard.id}"] [data-gb-menu]'); if (!b) return false; b.click(); return true })()`)
  await sleep(450)
  const btnMenu = await menuInfo(playedCard.id)
  check('卡片菜单按钮可打开菜单（绝对定位锚定在卡上）',
    toggleOpen === true && btnMenu.exists === true && btnMenu.position === 'absolute', brief({ position: btnMenu.position, exists: btnMenu.exists }))
  await evaluate(`document.querySelector('[data-gb-card="${playedCard.id}"] [data-gb-menu]').click()`)
  await sleep(450)
  check('再次点击菜单按钮关闭菜单', (await evaluate(`document.querySelectorAll('[data-gb-launch-menu]').length === 0`)) === true)

  // 5) 同时只保留一个菜单（右键另一张卡会关闭上一张的）
  const rc3Open = await evaluate(`(() => {
    const b = document.querySelector('[data-gb-card="${playedCard.id}"] [data-gb-menu]')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(450)
  const rc3 = { info: await menuInfo(playedCard.id) }
  const other = noSaveCard && noSaveCard.id !== playedCard.id ? noSaveCard : (menuCards.find((c) => c.id !== playedCard.id) || null)
  if (other) {
    const rc4 = await rightClick(other.id)
    await waitMenuLoaded(other.id)
    rc4.info = await menuInfo(other.id)
    check('右键另一张卡：上一张菜单关闭，只剩一个菜单且 id 更新',
      !!rc4 && rc4.info.exists && rc4.info.total === 1 && rc4.info.id === other.id, brief({ before: rc3 && rc3.info.id, after: rc4 && rc4.info.id, total: rc4 && rc4.info.total }))
    // 6) 无存档卡：空态
    if (noSaveCard && noSaveCard.id === other.id) {
      check('无存档卡的菜单显示 [data-gb-no-saves] 且没有 resume 项',
        rc4.info.noSaves === true && rc4.info.resumes.length === 0, brief({ noSaves: rc4.info.noSaves, resumes: rc4.info.resumes }))
      await S('02j-menu-no-saves.png')
    }
    await closeMenu()
  } else {
    console.log('  · 所有卡都有存档，跳过「无存档空态」用例')
    await closeMenu()
  }

  // 7) 引擎探针：记录 create / loadState，用于区分「新开」与「从存档继续」
  await evaluate(`(() => {
    window.__gbProbe = { creates: 0, loadState: [] }
    const core = window.GameBenchCore
    if (!core || typeof core.create !== 'function' || core.__gbProbeWrapped) return false
    const orig = core.create.bind(core)
    core.create = function (opts) {
      const api = orig(opts)
      window.__gbProbe.creates += 1
      try {
        const ls = api.loadState
        if (typeof ls === 'function') api.loadState = function (bytes) { window.__gbProbe.loadState.push({ len: bytes ? (bytes.byteLength || bytes.length || 0) : 0 }); return ls.apply(api, arguments) }
      } catch (_) { /* ignore */ }
      return api
    }
    core.__gbProbeWrapped = true
    return true
  })()`)

  // 8) 重新开始：新开（不 loadState）+ 画面跑起来
  await evaluate('window.__gbProbe.loadState.length = 0')
  const rcRestart = await rightClick(playedCard.id)
  const restartHit = await clickFirst(['[data-gb-restart]'], /重新开始|restart/i)
  check('右键菜单点击「重新开始」', !!restartHit, brief(restartHit))
  let restartPlayer = false
  try {
    await waitFor(`!!document.querySelector('[data-gb-player]')`, 'restart player view', 10000)
    restartPlayer = true
  } catch (err) { /* 报告 */ }
  check('「重新开始」直接进入播放器', restartPlayer)
  await sleep(1200)
  const restartProbe = await evaluate('window.__gbProbe')
  check('「重新开始」不读取存档（loadState 调用 0 次，startSlot=null）',
    !!restartProbe && restartProbe.loadState.length === 0, brief(restartProbe))
  await startPlayer('player start')
  await sleep(1000)
  let restartCanvas = false
  try {
    await waitFor(`(() => { const s = window.__gbCanvasStats(); return s && s.nonBlack > 500 })()`, 'restart canvas', 10000)
    restartCanvas = true
  } catch (err) { /* 报告 */ }
  check('重新开始后 canvas 非黑、engine 继续推进', restartCanvas && (await gbState()).crashed !== true, brief(await gbState()))
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(800)

  // 9) 从存档继续：右键 → [data-gb-resume-slot] → loadState 被调用且字节数与 IDB 一致
  const resumeSlot = expectedSlots[0] || (idbSaves[0] && idbSaves[0].slot) || '1'
  const freshIdb = await evaluate('window.__gbIdb()')
  const freshSaves = (freshIdb.meta || [])
    .filter((m) => m.store === 'saves' && m.gameId === playedCard.id)
    .map((m) => ({ slot: String(m.slot), bytes: m.stateBytes || m.bytes || 0 }))
  await evaluate('window.__gbProbe.loadState.length = 0')
  const rcResume = await rightClick(playedCard.id)
  const resumeBtn = await evaluate(`(() => {
    const b = document.querySelector('[data-gb-card="${playedCard.id}"] [data-gb-resume-slot="${resumeSlot}"]')
      || document.querySelector('[data-gb-launch-menu="${playedCard.id}"] [data-gb-resume-slot]')
    if (!b) return false
    b.click()
    return true
  })()`)
  check(`右键菜单点击「从存档继续」slot=${resumeSlot}`, resumeBtn === true, brief({ rcResume: rcResume && rcResume.info && rcResume.info.resumes }))
  let resumePlayer = false
  try {
    await waitFor(`!!document.querySelector('[data-gb-player]')`, 'resume player view', 10000)
    resumePlayer = true
  } catch (err) { /* 报告 */ }
  await sleep(1400)
  const resumeProbe = await evaluate('window.__gbProbe')
  const resumeCalls = (resumeProbe && resumeProbe.loadState) || []
  const expectedFresh = (freshSaves.find((s) => s.slot === resumeSlot) || {}).bytes || 0
  const lastLen = resumeCalls.length ? resumeCalls[resumeCalls.length - 1].len : 0
  const loadedRealSave = lastLen > 1000 && (lastLen === expectedFresh || freshSaves.some((s) => s.bytes === lastLen))
  check('「从存档继续」进入播放器并调用 engine.loadState（读到真实存档字节）',
    resumePlayer && resumeCalls.length >= 1 && loadedRealSave,
    brief({ resumePlayer, calls: resumeCalls, resumeSlot, expectedFresh, freshSaves }))
  await startPlayer('player start')
  await sleep(1000)
  let resumeCanvas = false
  try {
    await waitFor(`(() => { const s = window.__gbCanvasStats(); return s && s.nonBlack > 500 })()`, 'resume canvas', 10000)
    resumeCanvas = true
  } catch (err) { /* 报告 */ }
  check('读档继续后画面恢复（canvas 非黑、未崩溃）', resumeCanvas && (await gbState()).crashed !== true, brief(await gbState()))
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(800)

  // 10) 普通 click 仍直接启动（不 loadState、不弹菜单）
  await evaluate('window.__gbProbe.loadState.length = 0')
  const clickLaunch = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-gb-card]')]
    const card = cards.find((c) => c.getAttribute('data-gb-card') !== ${JSON.stringify(playedCard.id)}) || cards[0]
    if (!card) return false
    ;(card.querySelector('.gb-card-hit') || card).click()
    return true
  })()`)
  let clickPlayer = false
  try {
    await waitFor(`!!document.querySelector('[data-gb-player]')`, 'click launch player', 10000)
    clickPlayer = true
  } catch (err) { /* 报告 */ }
  check('普通 click 卡片仍直接启动游戏', clickLaunch === true && clickPlayer === true)
  await sleep(1200)
  const clickProbe = await evaluate('window.__gbProbe')
  check('普通 click 启动不读取存档（新开，startSlot=null）',
    !!clickProbe && clickProbe.loadState.length === 0 && (await evaluate(`document.querySelectorAll('[data-gb-launch-menu]').length === 0`)),
    brief(clickProbe))
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(700)
  check('退出后回到游戏库视图', (await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? r.getAttribute('data-gb-view') : null })()`)) === 'library')


  /* ================================================================ *
   * [5d] 手柄输入（两台标准手柄 1P/2P + 边沿去抖）
   *   fake navigator.getGamepads → GameBenchGamepads.assign/decode →
   *   client 16ms 轮询 → engine.setButton(name, down, player)
   * ================================================================ */
  section('[5d] 手柄输入（两台标准手柄 1P/2P）')
  const padModuleInfo = await evaluate(`(() => {
    const gp = window.GameBenchGamepads
    let profiles = null
    try { const s = window.__GAME_BENCH__.getState(); profiles = s && s.ui ? (s.ui.padProfiles && typeof s.ui.padProfiles === 'object' && !Array.isArray(s.ui.padProfiles)) : null } catch (_) { profiles = null }
    return {
      gamepads: !!(gp && typeof gp.assign === 'function' && typeof gp.decode === 'function' && typeof gp.identify === 'function'),
      settings: !!window.GameBenchGamepadSettings,
      profiles,
    }
  })()`)
  check('gamepads.js 已加载（assign/decode/identify 可用）', padModuleInfo.gamepads === true, brief(padModuleInfo))
  check('gamepad-settings.js 延后加载（设置页才需要，loadCore 只依赖 gamepads.js）',
    (await evaluate(`!!window.GameBenchGamepads`)) === true,
    brief({ settingsLoadedBeforeSettingsView: padModuleInfo.settings }))
  check('__GAME_BENCH__.getState().ui.padProfiles 为对象（手柄 profile 持久化字段存在）', padModuleInfo.profiles === true, brief(padModuleInfo))

  // 进入播放器并开始（轮询要求 engineStarted && 未暂停）
  await evaluate(`(() => { const cards = [...document.querySelectorAll('[data-gb-card]')]; const card = cards.find((c) => c.getAttribute('data-gb-card') === ${JSON.stringify(playedCard.id)}) || cards[0]; if (!card) return false; (card.querySelector('.gb-card-hit') || card).click(); return true })()`)
  await sleep(1300)
  await startPlayer('player start')
  await sleep(1000)
  const fakePads = await evaluate(`(() => {
    const make = (index, id) => ({ index, id, connected: true, mapping: 'standard', timestamp: Date.now(), axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) })
    const pad0 = make(0, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')
    const pad1 = make(1, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)')
    window.__gbFakePads = [pad0, pad1]
    try { Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__gbFakePads }) } catch (_) { /* ignore */ }
    return { ident: window.__gbFakePads.map((p) => window.GameBenchGamepads.identify(p)), keys: window.__gbFakePads.map((p) => window.GameBenchGamepads.key(p)) }
  })()`)
  check('两台手柄识别为 standard 且无需映射（needsMapping=false）',
    Array.isArray(fakePads.ident) && fakePads.ident.length === 2 && fakePads.ident.every((i) => i.standard === true && i.needsMapping === false), brief(fakePads))
  let padConnected = false
  try {
    await waitFor(`(() => { try { const s = window.__GAME_BENCH__.getState(); return !!(s && s.gamepadConnected === true) } catch (_) { return false } })()`, 'gamepad connected', 5000)
    padConnected = true
  } catch (err) { /* 报告 */ }
  check('client 轮询检测到两台手柄（gamepadConnected=true）', padConnected)
  const padRecords = () => evaluate(`(() => {
    const list = window.__gbEngines.filter((e) => !e.destroyed)
    const rec = list[list.length - 1]
    if (!rec) return []
    return rec.setButton.filter((b) => b.player === 1 || b.player === 2).slice(-40)
  })()`)

  // 1P 按 A（button 0）
  await evaluate('window.__gbFakePads[0].buttons[0].pressed = true; window.__gbFakePads[0].buttons[0].value = 1')
  await sleep(350)
  const p1Down = (await padRecords()).filter((b) => b.name === 'A' && b.player === 1 && b.down === true)
  check('1P 按下 A：engine.setButton(A,true,player=1) 仅一次（边沿）', p1Down.length === 1, brief(p1Down))
  await sleep(350)
  const p1Held = (await padRecords()).filter((b) => b.name === 'A' && b.player === 1 && b.down === true)
  check('按住不放不重复触发（16ms 轮询边沿去抖）', p1Held.length === 1, brief(p1Held.length))
  await evaluate('window.__gbFakePads[0].buttons[0].pressed = false; window.__gbFakePads[0].buttons[0].value = 0')
  await sleep(350)
  const p1Up = (await padRecords()).filter((b) => b.name === 'A' && b.player === 1 && b.down === false)
  check('1P 松开 A：engine.setButton(A,false,player=1) 一次', p1Up.length === 1, brief(p1Up))

  // 2P 按 START（button 9）
  await evaluate('window.__gbFakePads[1].buttons[9].pressed = true; window.__gbFakePads[1].buttons[9].value = 1')
  await sleep(400)
  const p2Start = (await padRecords()).filter((b) => b.name === 'START' && b.player === 2)
  check('2P 按下 START：engine.setButton(START,true,player=2)（1P/2P 分离）',
    p2Start.length >= 1 && p2Start[p2Start.length - 1].down === true, brief(p2Start))
  await evaluate('window.__gbFakePads[1].buttons[9].pressed = false; window.__gbFakePads[1].buttons[9].value = 0')
  await sleep(300)

  // 1P 摇杆向右（axes[0] = 0.9 > deadzone 0.45）
  await evaluate('window.__gbFakePads[0].axes[0] = 0.9')
  await sleep(400)
  const p1Right = (await padRecords()).filter((b) => b.name === 'RIGHT' && b.player === 1)
  check('1P 摇杆向右：engine.setButton(RIGHT,true,player=1)', p1Right.length >= 1 && p1Right[p1Right.length - 1].down === true, brief(p1Right))
  await evaluate('window.__gbFakePads[0].axes[0] = 0')
  await sleep(400)
  check('1P 摇杆回中：RIGHT 松开', (await padRecords()).some((b) => b.name === 'RIGHT' && b.player === 1 && b.down === false))

  // 清理 fake：退出后不应再有手柄事件
  await evaluate(`(() => { try { delete navigator.getGamepads } catch (_) {} ; window.__gbFakePads = null; return true })()`)
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(900)
  check('手柄测试后回到游戏库视图', (await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? r.getAttribute('data-gb-view') : null })()`)) === 'library')



  /* ================================================================ *
   * [5e] 设置页 · 手柄面板（标准 Pro + raw JoyCon 渲染 / 校准入口 / 无 console error）
   *   hooks：data-gb-gamepad-settings、data-gb-gamepad=key、data-gb-switch、
   *   data-gb-pad-deadzone、data-gb-pad-calibrate、data-gb-pad-reset、
   *   data-gb-calibrating、data-gb-pad-input、data-gb-pad-button、data-gb-pad-axis、
   *   data-gb-gamepad-notice
   * ================================================================ */
  section('[5e] 设置页 · 手柄面板（标准 Pro + raw JoyCon）')
  const settingsErrBefore = unexpectedErrors.length
  const fakeForSettings = await evaluate(`(() => {
    const make = (index, id, mapping) => ({ index, id, connected: true, mapping, timestamp: Date.now(), axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) })
    const pro = make(0, 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'standard')
    const joy = make(1, 'Joy-Con (L) (Vendor: 057e Product: 2006)', '')
    window.__gbFakePads = [pro, joy]
    try { Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__gbFakePads }) } catch (_) { /* ignore */ }
    const gp = window.GameBenchGamepads
    return { keys: window.__gbFakePads.map((p) => gp.key(p)), ident: window.__gbFakePads.map((p) => gp.identify(p)) }
  })()`)
  check('设置用 fake 手柄：标准 Pro + raw JoyCon（JoyCon 需映射）',
    !!fakeForSettings && fakeForSettings.ident[0].standard === true && fakeForSettings.ident[0].needsMapping === false
      && fakeForSettings.ident[1].nintendo === true && fakeForSettings.ident[1].needsMapping === true,
    brief(fakeForSettings && fakeForSettings.ident))

  // 打开设置页（ControllerSettings 懒加载两模块后渲染）
  await clickFirst(['[data-gb-settings]'], /设置/i)
  let padSettingsReady = false
  try {
    await waitFor(`!!document.querySelector('[data-gb-gamepad-settings]')`, 'gamepad settings panel', 12000)
    padSettingsReady = true
  } catch (err) { /* 报告 */ }
  check('设置页渲染手柄设置面板 [data-gb-gamepad-settings]', padSettingsReady)
  check('设置页已懒加载 gamepad-settings.js（window.GameBenchGamepadSettings.create 可用）',
    (await evaluate(`!!(window.GameBenchGamepadSettings && typeof window.GameBenchGamepadSettings.create === 'function')`)) === true)
  let padPanels = []
  try {
    await waitFor(`document.querySelectorAll('[data-gb-gamepad]').length >= 2`, 'gamepad device panels', 8000)
    padPanels = await evaluate(`[...document.querySelectorAll('[data-gb-gamepad]')].map((el) => el.getAttribute('data-gb-gamepad'))`)
  } catch (err) { /* 报告 */ }
  check('标准 Pro 与 raw JoyCon 各自渲染设备面板 [data-gb-gamepad]',
    padPanels.includes(fakeForSettings.keys[0]) && padPanels.includes(fakeForSettings.keys[1]), brief({ expected: fakeForSettings.keys, actual: padPanels }))
  const switchInfo = await evaluate(`(() => {
    const el = document.querySelector('[data-gb-switch="gb-merge-joycon"]')
    if (!el) return null
    return { exists: true, role: el.getAttribute('role'), checked: el.getAttribute('aria-checked') }
  })()`)
  check('「合并 Joy-Con」开关存在 [data-gb-switch="gb-merge-joycon"]', !!switchInfo && switchInfo.exists === true, brief(switchInfo))
  const calibrateCount = await countSel('[data-gb-pad-calibrate]')
  const resetCount = await countSel('[data-gb-pad-reset]')
  const deadzoneCount = await countSel('[data-gb-pad-deadzone]')
  check('每个设备都有校准入口 / 重置 / 死区滑杆',
    calibrateCount >= 2 && resetCount >= 2 && deadzoneCount >= 2, brief({ calibrateCount, resetCount, deadzoneCount }))
  check('输入可视化钩子存在（[data-gb-pad-input] / [data-gb-pad-axis]）',
    (await countSel('[data-gb-pad-input]')) >= 2 && (await countSel('[data-gb-pad-axis]')) > 0,
    brief({ input: await countSel('[data-gb-pad-input]'), axis: await countSel('[data-gb-pad-axis]') }))
  await S('17-settings-gamepad.png')

  // 合并 Joy-Con 开关：点击 → 状态写入 state.ui.padPaired（live getter）
  const mergeBefore = await evaluate(`(() => { try { return window.__GAME_BENCH__.getState().ui.padPaired } catch (_) { return undefined } })()`)
  await evaluate(`(document.querySelector('[data-gb-switch="gb-merge-joycon"]') || { click() {} }).click()`)
  await sleep(500)
  const mergeAfter = await evaluate(`(() => { try { return window.__GAME_BENCH__.getState().ui.padPaired } catch (_) { return undefined } })()`)
  check('点击「合并 Joy-Con」开关：padPaired 状态切换并回写',
    JSON.stringify(mergeBefore) !== JSON.stringify(mergeAfter), brief({ before: mergeBefore, after: mergeAfter }))
  await evaluate(`(document.querySelector('[data-gb-switch="gb-merge-joycon"]') || { click() {} }).click()`)
  await sleep(400)

  // 校准入口：开始 → [data-gb-calibrating] 出现；按 fake 键 → [data-gb-pad-button] 出现；再点取消 → 消失 + notice
  const joyKey = fakeForSettings.keys[1]
  const calibStart = await evaluate(`(() => {
    const b = document.querySelector('[data-gb-pad-calibrate="' + ${JSON.stringify(joyKey)} + '"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(500)
  const calibratingVisible = await evaluate(`!!document.querySelector('[data-gb-calibrating="${joyKey}"]') || document.querySelectorAll('[data-gb-calibrating]').length > 0`)
  check('点击校准入口：进入校准态 [data-gb-calibrating]', calibStart === true && calibratingVisible === true, brief({ calibStart, calibratingVisible }))
  await evaluate(`(() => { const p = window.__gbFakePads && window.__gbFakePads[1]; if (!p) return false; p.buttons[0].pressed = true; p.buttons[0].value = 1; return true })()`)
  await sleep(500)
  const padButtonShown = await evaluate(`document.querySelectorAll('[data-gb-pad-button]').length > 0`)
  check('校准中输入可视化：[data-gb-pad-button] 出现', padButtonShown)
  await evaluate(`(() => { const el = document.querySelector('[data-gb-calibrating]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); return !!el })()`)
  await sleep(400)
  await S('18-gamepad-calibrating.png')
  await evaluate(`(() => { const p = window.__gbFakePads && window.__gbFakePads[1]; if (!p) return false; p.buttons[0].pressed = false; p.buttons[0].value = 0; return true })()`)
  await evaluate(`(() => { const b = document.querySelector('[data-gb-pad-calibrate="' + ${JSON.stringify(joyKey)} + '"]'); if (b) { b.click(); return true } return false })()`)
  await sleep(600)
  check('再次点击取消校准：[data-gb-calibrating] 消失', (await evaluate(`document.querySelectorAll('[data-gb-calibrating]').length === 0`)) === true)
  const notice = await evaluate(`(() => { const el = document.querySelector('[data-gb-gamepad-notice]'); return el ? { type: el.getAttribute('data-gb-gamepad-notice'), text: (el.textContent || '').trim() } : null })()`)
  check('取消校准后有可读 notice（[data-gb-gamepad-notice]）', !!notice && notice.text.length > 0, brief(notice))
  check('手柄设置页全程无 console.error / pageerror', unexpectedErrors.length === settingsErrBefore, brief(unexpectedErrors.slice(settingsErrBefore)))

  // 清理 fake + 返回游戏库
  await evaluate(`(() => { try { delete navigator.getGamepads } catch (_) {} ; window.__gbFakePads = null; return true })()`)
  await clickFirst(['[data-gb-settings-back]'], /返回|back/i)
  await sleep(700)
  check('手柄设置测试后回到游戏库', (await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? r.getAttribute('data-gb-view') : null })()`)) === 'library')


  /* ================================================================ *
   * [6] 市场：合集 / 搜索 / 安装 / 错误态
   * ================================================================ */
  // 先退出播放器回到游戏库（真实 client 的 tab 在 player 视图下隐藏）
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(800)
  const backView = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? r.getAttribute('data-gb-view') : null })()`)
  check('播放器返回游戏库视图', backView === 'library', brief(backView))

  // 设置页：画面模式三选一
  await clickFirst(['[data-gb-settings]'], /设置/i)
  await sleep(700)
  const screenSettings = await evaluate(`[...document.querySelectorAll('[data-gb-screen-mode-setting]')].map((b) => ({ v: b.getAttribute('data-gb-screen-mode-setting'), on: b.getAttribute('aria-checked') }))`)
  check('设置页有画面模式三选一（fit/stretch/pixel）', screenSettings.length === 3 && screenSettings.some((x) => x.v === 'fit') && screenSettings.some((x) => x.v === 'stretch') && screenSettings.some((x) => x.v === 'pixel'), brief(screenSettings))
  await S('16-settings.png')
  await clickFirst(['[data-gb-settings-back]'], /返回|back/i)
  await sleep(600)
  section('[6] 市场（合集 / 搜索 / 安装 / 错误态）')
  const beforeInstall = await evaluate(`(async () => { const r = await fetch('/game-bench/api/library'); const j = await r.json(); return j.data.games.length })()`)
  const marketTab = await gotoTab('market')
  const tabDiag = await evaluate(`[...document.querySelectorAll('[data-gb-tab]')].map(e => ({ v: e.getAttribute('data-gb-tab'), w: Math.round(e.getBoundingClientRect().width) }))`)
  check('切换到市场 tab', !!marketTab, brief({ hit: marketTab, tabs: tabDiag }))
  let marketReady = false
  try {
    await waitFor(`(() => {
      const r = document.querySelector('[data-gb="root"]')
      const st = document.querySelector('[data-gb-status]')
      return (r && r.getAttribute('data-gb-view') === 'market') || /^market-/.test((st && st.getAttribute('data-gb-status')) || '')
    })()`, 'market view', 12000)
    await waitFor(`document.querySelectorAll('[data-gb-market]').length >= 8`, 'market cards', 15000)
    marketReady = true
  } catch (err) { /* 断言报告 */ }
  const marketCards = await gbCards()
  const realMarketCards = marketCards.filter((c) => c.market)
  check('市场渲染 ≥8 张卡片（[data-gb-market]）', marketReady && realMarketCards.length >= 8, `${realMarketCards.length} 张`)
  const chips = await evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-gb-collection]')]
    return { count: els.length, texts: els.map(e => (e.textContent || '').trim()).slice(0, 10) }
  })()`)
  check('市场展示合集 chips（≥2 个，含中文合集名）', chips.count >= 2 && chips.texts.some((t) => /[\u4e00-\u9fa5]/.test(t)), brief(chips))
  check('市场卡片封面真实加载', realMarketCards.slice(0, 8).length > 0 && realMarketCards.slice(0, 8).every((c) => c.imgNatural > 0), brief(realMarketCards.slice(0, 8).map((c) => c.imgNatural)))
  await S('07-market-dark.png')

  // 搜索市场（魂斗罗 / 坦克大战）：走 Host /catalog?q=
  const searchPresent = await evaluate(`!!document.querySelector('[data-gb-search]')`)
  check('市场搜索框存在（[data-gb-search]）', searchPresent)
  if (searchPresent) {
    await evaluate(`window.__gbSetInput('[data-gb-search]', '魂斗罗')`)
    await sleep(1200)
    const searchCards = await gbCards()
    check('市场搜索「魂斗罗」有结果', searchCards.length > 0 && searchCards.some((c) => /魂斗罗/.test(c.text)), brief(searchCards.map((c) => c.text).slice(0, 5)))
    const searchCalls = await findCalls('/game-bench/api/catalog', /q=/)
    const hitQ = searchCalls.some((c) => decodeURIComponent(c.search || '').includes('魂斗罗'))
    check('搜索请求带 q=魂斗罗（Host 侧过滤）', hitQ, brief(searchCalls.map((c) => decodeURIComponent(c.search || '')).slice(0, 3)))
    await S('08-market-search.png')
    await evaluate(`window.__gbSetInput('[data-gb-search]', '坦克大战')`)
    await sleep(1200)
    const tankCards = await gbCards()
    check('市场搜索「坦克大战」有结果', tankCards.length > 0 && tankCards.some((c) => /坦克/.test(c.text)), brief(tankCards.map((c) => c.text).slice(0, 5)))
    await evaluate(`window.__gbSetInput('[data-gb-search]', '')`)
    await sleep(1200)
  }

  // 安装一款（市场卡片上的安装按钮）
  await resetCalls()
  const installRes = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-gb-market]')]
    const card = cards.find((c) => c.querySelector('[data-gb-install]') && !c.querySelector('[data-gb-installed]'))
      || cards.find((c) => c.querySelector('[data-gb-install]'))
    if (!card) return { hit: null, count: cards.length }
    try { card.scrollIntoView({ block: 'center' }) } catch (_) {}
    const id = card.getAttribute('data-gb-market')
    card.querySelector('[data-gb-install]').click()
    return { hit: 'market-install', id }
  })()`)
  const installHit = installRes && installRes.hit
  const installId = installRes && installRes.id
  check('点击市场安装按钮', !!installHit, brief(installRes))
  let installCalled = false
  try {
    await waitUntil(async () => (await findCalls('/game-bench/api/install')).length > 0, 'POST /install', 10000)
    installCalled = true
  } catch (err) { /* 断言报告 */ }
  check('发出 POST /install 请求', installCalled, brief(await findCalls('/game-bench/api/install')))
  let installedOk = false
  try {
    await waitFor(`(() => {
      const targetId = ${JSON.stringify(installId)}
      const cards = [...document.querySelectorAll('[data-gb-market]')]
      const hit = cards.find((c) => c.getAttribute('data-gb-market') === targetId)
      const pool = hit ? [hit] : cards
      return pool.some((c) => !!c.querySelector('[data-gb-installed]') || /已安装/.test(c.textContent || ''))
    })()`, 'card installed state', 12000)
    installedOk = true
  } catch (err) { /* 断言报告 */ }
  check('安装的那款卡片变为「已安装」', installedOk, brief({ installId }))
  const installToast = await evaluate(`(() => { const el = document.querySelector('[data-gb-toast]'); return el ? (el.textContent || '').trim() : '' })()`)
  check('安装成功有 toast 反馈', /安装|成功/.test(installToast) || installedOk, brief(installToast))
  await S('09-market-installed.png')
  const afterInstall = await evaluate(`(async () => { const r = await fetch('/game-bench/api/library'); const j = await r.json(); return j.data.games.length })()`)
  check('安装后 /library 游戏数 +1', afterInstall === beforeInstall + 1, `${beforeInstall} → ${afterInstall}`)
  await gotoTab('library')
  await sleep(900)
  const libraryAfterInstall = await countSel('[data-gb-card]')
  check(`游戏库多出一张卡片（${beforeInstall} → ${beforeInstall + 1}）`, libraryAfterInstall === beforeInstall + 1, libraryAfterInstall)
  await S('10-library-with-installed.png')

  // 错误态：需要授权
  console.log('  — 错误态：需要 GitHub 授权（mode=auth）')
  await config({ mode: 'auth' })
  allowErrors = true
  await reload()
  await waitMounted()
  await sleep(700)
  await gotoTab('market')
  let authErr = false
  try {
    await waitFor(`(() => {
      const st = document.querySelector('[data-gb-status]')
      return (st && st.getAttribute('data-gb-status') === 'market-auth') || /GitHub 访问权限|粘贴 Token|gh auth login/.test((document.querySelector('[data-gb="root"]') || document.body).textContent || '')
    })()`, 'auth error state', 12000)
    authErr = true
  } catch (err) { /* 断言报告 */ }
  const authText = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? (r.textContent || '').slice(0, 500) : '' })()`)
  check('市场 401 → 显示授权引导错误态', authErr, brief(authText))
  check('错误态文案含可操作指引（Token / gh auth login / 权限）', /Token|gh auth login|权限|授权/i.test(authText || ''), brief(authText))
  const authActions = await evaluate(`(() => {
    const root = document.querySelector('[data-gb="root"]')
    if (!root) return null
    const targets = [
      ...root.querySelectorAll('.gb-state-actions button, [data-gb-retry], [data-gb="root"] .gb-state-actions a'),
    ]
    const labels = targets.map((b) => (b.textContent || '').trim()).filter(Boolean)
    return { count: targets.length, labels }
  })()`)
  check('授权错误态提供可操作按钮（重试 / 去设置粘贴 Token）',
    !!authActions && (authActions.count > 0 || (authActions.labels || []).length > 0), brief(authActions))
  await S('11-market-auth-error.png')

  // 错误态：离线 / 上游失败
  console.log('  — 错误态：连不上 GitHub（mode=offline）')
  await config({ mode: 'offline' })
  await reload()
  await waitMounted()
  await sleep(700)
  await gotoTab('market')
  let offErr = false
  try {
    await waitFor(`(() => {
      const st = document.querySelector('[data-gb-status]')
      return (st && st.getAttribute('data-gb-status') === 'market-error') || /连不上 GitHub|网络|NETWORK/.test((document.querySelector('[data-gb="root"]') || document.body).textContent || '')
    })()`, 'offline error state', 12000)
    offErr = true
  } catch (err) { /* 断言报告 */ }
  const offText = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? (r.textContent || '').slice(0, 500) : '' })()`)
  check('市场 502 → 显示网络错误态', offErr, brief(offText))
  check('离线错误态文案提示「内置游戏不受影响」或同类降级说明',
    /内置|不影响|离线/.test(offText || '') || /网络|连接|GitHub/i.test(offText || ''), brief(offText))
  check('网络错误态提供重试按钮', await evaluate(`!!document.querySelector('[data-gb-retry="market"]') || !!document.querySelector('[data-gb-retry]')`))
  await S('12-market-offline-error.png')
  await gotoTab('library')
  await sleep(700)
  const offlineCards = await countSel('[data-gb-card]')
  check('离线时内置游戏仍在（库中有卡片）', offlineCards >= expectedBuiltinCount, { cards: offlineCards, expectedBuiltinCount })
  await S('12b-offline-library.png')
  allowErrors = false
  await config({ mode: null })

  /* ================================================================ *
   * [7] 主题：深色 / 浅色
   * ================================================================ */
  section('[7] 主题（深色 / 浅色）')
  await reload()
  await waitMounted()
  await setViewport(1440, 900)
  await setColorScheme('dark')
  await setTheme('dark')
  await sleep(500)
  const darkVars = await evaluate(`(() => {
    const root = document.querySelector('[data-gb="root"]')
    const cs = root ? getComputedStyle(root) : null
    return { bg: cs ? cs.backgroundColor : null, color: cs ? cs.color : null, base: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim() }
  })()`)
  await S('00b-library-dark.png')
  await setColorScheme('light')
  await setTheme('light')
  await sleep(500)
  const lightVars = await evaluate(`(() => {
    const root = document.querySelector('[data-gb="root"]')
    const cs = root ? getComputedStyle(root) : null
    return { bg: cs ? cs.backgroundColor : null, color: cs ? cs.color : null, base: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim() }
  })()`)
  await S('13-library-light.png')
  check('深色/浅色 token 生效（背景 token 不同）', darkVars.base !== lightVars.base, brief({ dark: darkVars.base, light: lightVars.base }))
  check('主面板颜色随主题变化（深/浅背景或前景不同）',
    (darkVars.bg !== lightVars.bg) || (darkVars.color !== lightVars.color), brief({ dark: darkVars, light: lightVars }))

  /* ================================================================ *
   * [8] 响应式：600 / 1440 无横向溢出
   * ================================================================ */
  section('[8] 响应式（600 / 1440）')
  await setColorScheme('dark')
  await setTheme('dark')
  const sizes = [[600, 820, '14-600-narrow.png'], [1440, 900, '15-1440-wide.png']]
  for (const [w, h, shot] of sizes) {
    await setViewport(w, h)
    await sleep(700)
    const o = await overflowReport()
    check(`${w}px 视口无横向溢出（scrollWidth ≤ clientWidth + 2）`,
      o.docScroll <= o.docClient + 2 && (o.rootScroll == null || o.rootScroll <= o.rootClient + 2), brief(o))
    const rootBox = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); const b = r && r.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null })()`)
    check(`${w}px 视口下面板有可用尺寸（宽>280 高>200）`, !!rootBox && rootBox.w > 280 && rootBox.h > 200, brief(rootBox))
    if (w === 600) await S(shot)
    else await S(shot)
  }
  await setViewport(1440, 900)
  await sleep(400)


  /* ================================================================ *
   * [8b] 渲染缩放诊断（DPR / 整数倍 / CSS transform）
   *   目的：定位「像素错位 / 8px tile 裂缝」是否来自 CSS 缩放：
   *   pixel 模式应严格 256/240 整数倍；fit 模式 4:3 横向拉伸 1.25x 属设计。
   * ================================================================ */
  /* ================================================================ *
   * [8b] 渲染缩放诊断（默认 pixel / DPR 1.25·1.5·2 / 物理像素 + transform 吸附）
   *   生产：默认 screenMode='pixel'；screenSizeFor(mode, w, h, dpr) 按设备物理像素取整数倍；
   *   measure 时对 dx/dy 做物理像素吸附（screen frame 用 translate 微调）。
   * ================================================================ */
  section('[8b] 渲染缩放诊断（默认 pixel / DPR / transform 吸附）')
  const setScreenMode = async (target) => {
    for (let i = 0; i < 4; i++) {
      const cur = await evaluate(`(() => { const b = document.querySelector('[data-gb-screen-mode]'); return b ? b.getAttribute('data-gb-screen-mode') : null })()`)
      if (cur === target) return true
      await evaluate(`(document.querySelector('[data-gb-screen-mode]') || { click() {} }).click()`)
      await sleep(400)
    }
    return false
  }
  await evaluate(`(() => { const cards = [...document.querySelectorAll('[data-gb-card]')]; const card = cards.find((c) => /超级玛丽|魂斗罗/.test(c.textContent || '')) || cards[0]; if (!card) return false; (card.querySelector('.gb-card-hit') || card).click(); return true })()`)
  await sleep(1200)
  await startPlayer('dpr player start')
  await sleep(600)
  const renderMetrics = () => evaluate(`(() => {
    const c = document.querySelector('[data-gb-canvas]') || document.querySelector('[data-gb="root"] canvas')
    const frame = document.querySelector('[data-gb-stage]')
    const outer = document.querySelector('[data-gb-player] .gb-player-stage') || (frame && frame.parentElement)
    if (!c || !frame) return null
    const r = c.getBoundingClientRect()
    const fr = frame.getBoundingClientRect()
    const or = outer ? outer.getBoundingClientRect() : null
    const dpr = window.devicePixelRatio || 1
    const css = getComputedStyle(c)
    const frameCss = getComputedStyle(frame)
    const values = frameCss.transform && frameCss.transform !== 'none' ? frameCss.transform.replace(/^matrix\\(|\\)$/g, '').split(',').map(Number) : null
    const scaleX = values ? values[0] : 1
    const scaleY = values ? values[3] : 1
    const skew = values ? Math.max(Math.abs(values[1]), Math.abs(values[2])) : 0
    const tx = values ? values[4] : 0
    const ty = values ? values[5] : 0
    const ancestorTransforms = []
    let el = frame.parentElement
    while (el && el !== document.body) {
      const t = getComputedStyle(el).transform
      if (t && t !== 'none') ancestorTransforms.push({ cls: String(el.className || '').slice(0, 36), transform: t })
      el = el.parentElement
    }
    const kx = r.width * dpr / 256
    const ky = r.height * dpr / 240
    const originX = or ? (fr.left - or.left) * dpr : null
    const originY = or ? (fr.top - or.top) * dpr : null
    const absX = fr.left * dpr
    const absY = fr.top * dpr
    const nearInt = (v, tol) => v !== null && Math.abs(v - Math.round(v)) <= tol
    return {
      mode: (document.querySelector('[data-gb-screen-mode]') || { getAttribute: () => null }).getAttribute('data-gb-screen-mode'),
      dpr,
      cssW: +r.width.toFixed(4), cssH: +r.height.toFixed(4),
      kx: +kx.toFixed(4), ky: +ky.toFixed(4),
      physInt: Math.abs(kx - Math.round(kx)) <= 0.02 && Math.abs(ky - Math.round(ky)) <= 0.02 && Math.round(kx) >= 1 && Math.round(kx) === Math.round(ky),
      canvasTransform: css.transform,
      frameTransform: frameCss.transform,
      pureTranslate: Math.abs(scaleX - 1) < 1e-6 && Math.abs(scaleY - 1) < 1e-6 && skew < 1e-6,
      tx: +tx.toFixed(4), ty: +ty.toFixed(4),
      ancestorTransforms,
      originX: originX === null ? null : +originX.toFixed(4),
      originY: originY === null ? null : +originY.toFixed(4),
      originXInt: nearInt(originX, 0.02),
      originYInt: nearInt(originY, 0.02),
      absX: +absX.toFixed(4),
      absY: +absY.toFixed(4),
      absXInt: nearInt(absX, 0.02),
      absYInt: nearInt(absY, 0.02),
      imageRendering: css.imageRendering,
      cssRatio: r.height ? +(r.width / r.height).toFixed(4) : 0,
      transformMatrix: values,
    }
  })()`)

  const base = await renderMetrics()
  check('默认 pixel：物理像素 256/240 整数倍（DPR 感知）', !!base && base.mode === 'pixel' && base.physInt,
    brief(base && { mode: base.mode, dpr: base.dpr, cssW: base.cssW, cssH: base.cssH, kx: base.kx, ky: base.ky }))
  check('canvas 自身无 CSS transform；screen frame 仅纯 translate（物理像素吸附），无 scale/skew',
    !!base && base.canvasTransform === 'none' && base.pureTranslate === true && (base.ancestorTransforms || []).length === 0,
    brief(base && { canvasTransform: base.canvasTransform, frameTransform: base.frameTransform, tx: base.tx, ty: base.ty, ancestors: base.ancestorTransforms }))
  check('canvas image-rendering = pixelated/crisp-edges（非模糊插值）',
    !!base && /pixelated|crisp-edges/.test(base.imageRendering || ''), base && base.imageRendering)
  check('DPR=1：screen 绝对原点（viewport 坐标）× DPR 吸附到整数（±0.02，渲染对齐不变量）',
    !!base && base.absXInt === true && base.absYInt === true,
    brief(base && { absX: base.absX, absY: base.absY, relX: base.originX, relY: base.originY }))
  await S('02k-player-pixel-dpr1.png')

  for (const dpr of [1.25, 1.5, 2]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false })
    // deviceMetricsOverride 不会派发 window.resize；真实缩放/换屏会 → 主动派发让 client 重新 measure
    await evaluate(`window.dispatchEvent(new Event('resize'))`)
    await sleep(1300)
    const m = await renderMetrics()
    check(`DPR=${dpr}：pixel 物理像素整数倍（w*dpr/256 = h*dpr/240 同整数）`,
      !!m && m.dpr === dpr && m.mode === 'pixel' && m.physInt,
      brief(m && { dpr: m.dpr, cssW: m.cssW, cssH: m.cssH, kx: m.kx, ky: m.ky }))
    check(`DPR=${dpr}：screen 绝对原点 × DPR 吸附到整数（±0.02）`,
      !!m && m.absXInt === true && m.absYInt === true,
      brief(m && { absX: m.absX, absY: m.absY, relToStageX: m.originX, relToStageY: m.originY }))
    console.log(`  · DPR=${dpr} 相对 stage 原点（不变量：stage 本身可能非设备像素对齐）：` + brief(m && { x: m.originX, y: m.originY }))
    check(`DPR=${dpr}：frame 仍为纯 translate（无 scale/skew）`,
      !!m && m.pureTranslate === true, brief(m && { transformMatrix: m.transformMatrix }))
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`window.dispatchEvent(new Event('resize'))`)
  await sleep(1100)

  // fit 诊断：4:3 观感拉伸（横向 1.25x，非 16:15），仍走物理像素吸附；仅记录缩放比供排查 8px tile 裂缝
  await setScreenMode('fit')
  await sleep(600)
  const mf = await renderMetrics()
  check('fit 模式：CSS 仍为 4:3（横向 1.25x 观感拉伸）',
    !!mf && mf.mode === 'fit' && Math.abs(mf.cssRatio - 4 / 3) < 0.02, brief(mf && { mode: mf.mode, cssW: mf.cssW, cssH: mf.cssH, ratio: mf.cssRatio }))
  check('fit 模式：screen frame 仅纯 translate（无 CSS scale，缩放由宽高决定）',
    !!mf && mf.pureTranslate === true, brief(mf && { transformMatrix: mf.transformMatrix }))
  console.log('  · fit 缩放诊断：' + brief(mf && { cssW: mf.cssW, cssH: mf.cssH, sx: +(mf.cssW / 256).toFixed(4), sy: +(mf.cssH / 240).toFixed(4), ratio: mf.cssRatio, dpr: mf.dpr, tx: mf.tx, ty: mf.ty }))
  await setScreenMode('pixel')
  await sleep(500)
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(800)
  await setViewport(1440, 900)
  await sleep(300)


  /* ================================================================ *
   * [9] 运行期健康
   * ================================================================ */
  section('[9] 运行期健康')
  await sleep(400)
  check('整轮运行无未捕获页面异常（超出预期错误态部分）', unexpectedErrors.length === 0, brief(unexpectedErrors.slice(0, 4)))
  check('页面最终仍可用（[data-gb="root"] 存在）', await evaluate(`!!document.querySelector('[data-gb="root"]')`))
  const finalState = await gbState()
  const finalPlayerVisible = await evaluate(`!!document.querySelector('[data-gb-player]')`)
  if (finalPlayerVisible) {
    check('结束状态：播放器仍挂载时 engine 正常（无 crashed / 未误销毁）',
      finalState.destroyed === false && finalState.crashed !== true,
      brief({ destroyed: finalState.destroyed, crashed: finalState.crashed, audio: finalState.audio }))
  } else {
    check('结束状态：无播放器实例（已回库/卸载，engine 无残留）', finalPlayerVisible === false, `engines=${finalState.engines}`)
  }

} catch (err) {
  fatal = err
  failures.push({ label: `FATAL: ${err.message}`, extra: undefined })
  console.error('\nFATAL:', err.stack || err)
  if (errors.length) console.error('page errors:', errors.slice(0, 8).join('\n'))
  try { shots.push(await screenshot('99-fatal.png')) } catch { /* ignore */ }
} finally {
  console.log('\n================ 验收结果 ================')
  console.log(`PASS ${passed.length} / FAIL ${failures.length}${fatal ? '（含 FATAL）' : ''}`)
  if (failures.length) {
    console.log('\nFAIL 清单：')
    for (const f of failures) {
      console.log(`  ✗ ${f.label}${f.extra === undefined ? '' : ` → ${typeof f.extra === 'string' ? f.extra : JSON.stringify(f.extra)}`}`)
    }
  }
  if (shots.length) {
    console.log('\n截图：')
    for (const s of shots) console.log('  ' + s)
  }
  const log = [
    `# dsh-game-bench-selftest ${new Date().toISOString()}`,
    `client: ${CLIENT}`,
    `engine: ${ENGINE} (${existsSync(ENGINE) ? 'present' : 'MISSING'})`,
    `jsnes : ${JSNES} (${existsSync(JSNES) ? 'present' : 'MISSING'})`,
    `mock: ${BASE}  builtin=${serverInfo.builtin} market=${serverInfo.market} collections=${serverInfo.collections}`,
    `PASS ${passed.length} / FAIL ${failures.length}${fatal ? '（含 FATAL）' : ''}`,
    '',
    '## PASS',
    ...passed.map((p) => `- ${p}`),
    '',
    '## FAIL',
    ...failures.map((f) => `- ${f.label}${f.extra === undefined ? '' : ` → ${typeof f.extra === 'string' ? f.extra : JSON.stringify(f.extra)}`}`),
    '',
    '## SHOTS',
    ...shots.map((s) => `- ${s}`),
    '',
    '## console errors (all)',
    ...errors.slice(0, 40).map((e) => `- ${String(e).slice(0, 500)}`),
    '',
    '## unexpected console errors',
    ...unexpectedErrors.slice(0, 20).map((e) => `- ${String(e).slice(0, 500)}`),
  ].join('\n')
  writeFileSync(join(HERE, 'last-run.log'), log)

  clearTimeout(watchdog)
  cdp.close()
  try { chrome.kill('SIGKILL') } catch { /* ignore */ }
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0)
}
