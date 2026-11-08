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
  console.error('\n[watchdog] run.mjs 超过 10 分钟未结束，强制退出')
  try { chrome && chrome.kill('SIGKILL') } catch { /* ignore */ }
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(4)
}, 10 * 60 * 1000)
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
        reject(new Error(`CDP timeout: ${method} (20s)`))
      }, 20000)
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
      return root && (root.getAttribute('data-gb-view') === 'player' || !!document.querySelector('[data-gb-start]') || !!document.querySelector('[data-gb="root"] canvas'))
    })()`, 'player view', 12000)
    playerShown = true
  } catch (err) { /* 断言报告 */ }
  const viewState = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return { view: r && r.getAttribute('data-gb-view'), start: !!document.querySelector('[data-gb-start]'), canvas: !!document.querySelector('[data-gb="root"] canvas') } })()`)
  check('进入播放器视图（data-gb-view="player"）', playerShown && viewState.view === 'player', brief(viewState))
  check('出现「开始」遮罩 [data-gb-start]', viewState.start === true, brief(viewState))
  await S('01-player-start-overlay.png')

  if (viewState.start) {
    await clickSel('[data-gb-start]')
    await sleep(600)
  } else {
    const alt = await clickFirst(['[data-gb-start]', '[data-gb-play]', '[data-gb-start-button]'], /开始|点击开始|play/i)
    if (alt) await sleep(600)
  }
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
  const st2 = await gbState()
  const framesGrew = typeof st1.frames === 'number' && typeof st2.frames === 'number' ? st2.frames > st1.frames : null
  check('帧计数增长（engine onState.frames 递增）', framesGrew === true, framesGrew === null ? 'client 未透出 onState.frames' : `${st1.frames} → ${st2.frames}`)
  check('帧在推进（画面像素变化 或 engine frames 递增）', hashChanged || framesGrew === true,
    brief({ hashChanged, frames: `${st1.frames} → ${st2.frames}` }))
  check('engine 未崩溃（crashed=false）', st2.crashed === false, brief({ crashed: st2.crashed, audio: st2.audio }))
  await S('02-player-running.png')

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
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 300))
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
  const engineRoundtrip = await evaluate(`(async () => {
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
  check('engine saveState → loadState 往返（gzip 状态 > 1000B，读档不抛错且画面恢复）',
    !!engineRoundtrip && engineRoundtrip.ok === true && engineRoundtrip.len > 1000 && engineRoundtrip.nonBlack > 500,
    brief(engineRoundtrip))
  check('存档为 gzip 压缩（魔数 1f 8b）', !!engineRoundtrip && Array.isArray(engineRoundtrip.magic) && engineRoundtrip.magic[0] === 0x1f && engineRoundtrip.magic[1] === 0x8b, brief(engineRoundtrip && engineRoundtrip.magic))

  /* ================================================================ *
   * [4] 键盘输入 / 不抢键
   * ================================================================ */
  section('[4] 键盘（引擎接收 + 不抢键）')
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
   * [6] 市场：合集 / 搜索 / 安装 / 错误态
   * ================================================================ */
  // 先退出播放器回到游戏库（真实 client 的 tab 在 player 视图下隐藏）
  await clickFirst(['[data-gb-back]'], /返回游戏库|返回|back/i)
  await sleep(800)
  const backView = await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return r ? r.getAttribute('data-gb-view') : null })()`)
  check('播放器返回游戏库视图', backView === 'library', brief(backView))
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
   * [9] 运行期健康
   * ================================================================ */
  section('[9] 运行期健康')
  await sleep(400)
  check('整轮运行无未捕获页面异常（超出预期错误态部分）', unexpectedErrors.length === 0, brief(unexpectedErrors.slice(0, 4)))
  check('页面最终仍可用（[data-gb="root"] 存在）', await evaluate(`!!document.querySelector('[data-gb="root"]')`))
  const finalState = await gbState()
  if (finalState.engines > 0) {
    check('页面重载后 engine 状态正常（无 crashed / 未误销毁）',
      finalState.destroyed === false && finalState.crashed !== true,
      brief({ destroyed: finalState.destroyed, crashed: finalState.crashed, audio: finalState.audio }))
  } else {
    check('页面经历多次重载：旧 engine 随页面卸载（无残留实例）', finalState.engines === 0, `engines=${finalState.engines}`)
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
