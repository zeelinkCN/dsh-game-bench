#!/usr/bin/env node
/**
 * 拾光游戏厅 · 真实 DSH 页面验收（Lead 安装插件之后跑）
 *
 * 打开正在运行的 DSH Web GUI（默认 http://127.0.0.1:61254），在真实页面里：
 *   1. 等页面壳与 window.__ModuleLoader__ 就绪
 *   2. 断言左侧栏出现游戏厅入口 [data-gb-entry]（或 aria-label 含「游戏」）
 *   3. 点击入口 → 主区域出现 [data-gb="root"]
 *   4. 切「游戏库」→ 点第一张内置卡 → 点开始 → 断言 canvas 非黑、帧在动
 *   5. 截图 shots/real-*.png（侧栏入口 / 游戏库 / 播放中）
 *
 * 用法：
 *   node real-page.mjs                          # 默认取 DSH_WEB_URL（本会话为 http://127.0.0.1:60333）
 *   DSH_URL="http://127.0.0.1:<port>/?token=…" node real-page.mjs
 *
 * 退出码：0 全绿 / 1 有 FAIL / 2 插件未安装或页面未就绪（等待 Lead，不误报 FAIL）/ 3 找不到 Chrome / 4 看门狗超时
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
const TMP = join(HERE, 'tmp')
const DSH_URL = (process.env.DSH_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:61254').replace(/\/+$/, '')
const NODE = process.execPath

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
  process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '',
  process.platform === 'linux' ? '/usr/bin/google-chrome' : '',
].filter((c) => c && existsSync(c))
const CHROME = CHROME_CANDIDATES[0] || ''

mkdirSync(SHOTS, { recursive: true })
mkdirSync(TMP, { recursive: true })
try { for (const f of readdirSync(SHOTS)) if (/^real-.*\.png$/i.test(f)) rmSync(join(SHOTS, f), { force: true }) } catch { /* ignore */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const passed = []
const failures = []
function check(label, ok, extra) {
  if (ok) { passed.push(label); console.log(`  ✓ ${label}${extra === undefined ? '' : ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})`}`) }
  else { failures.push({ label, extra }); console.log(`  ✗ ${label}${extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`) }
}
const brief = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > n ? s.slice(0, n) + '…' : s
}

if (!CHROME) { console.error('[环境错误] 找不到 Chrome'); process.exit(3) }

const profileDir = join(TMP, 'real-chrome-profile')
try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = new Map() }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', rej, { once: true })
    })
    this.ws.addEventListener('close', () => { for (const { reject } of this.pending.values()) reject(new Error('CDP closed')); this.pending.clear() })
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 25000)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    })
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn) }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

const chrome = spawn(CHROME, [
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
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let chromeStderr = ''
chrome.stderr.on('data', (b) => { chromeStderr += b.toString() })

let cdp = null
let fatal = null
let notInstalled = false
let installStateReason = ''
const watchdog = setTimeout(() => {
  console.error('\n[watchdog] real-page.mjs 超时（5 分钟），强制退出')
  try { chrome.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(4)
}, 5 * 60 * 1000)
watchdog.unref?.()

const shots = []
async function evaluate(expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) {
    throw new Error(`eval failed: ${brief(expression)}\n${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`)
  }
  return res.result.value
}
async function waitFor(expression, label, timeout = 15000, interval = 200) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try { last = await evaluate(expression) } catch (err) { last = String(err) }
    if (last) return last
    await sleep(interval)
  }
  throw new Error(`waitFor timeout: ${label}; last=${brief(last)}`)
}
async function screenshot(name, clip) {
  await sleep(400)
  const params = { format: 'png' }
  if (clip) params.clip = clip
  const { data } = await cdp.send('Page.captureScreenshot', params)
  const file = join(SHOTS, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`  · screenshot ${file}`)
  shots.push(file)
  return file
}
async function screenshotRegion(selector, name, scale = 5, pad = 10) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })()`)
  if (!box || box.w < 2 || box.h < 2) return false
  await screenshot(name, {
    x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
    width: Math.max(2, box.w + pad * 2), height: Math.max(2, box.h + pad * 2), scale,
  })
  return true
}

try {
  const devtoolsFile = join(profileDir, 'DevToolsActivePort')
  const debugPort = await (async () => {
    for (let i = 0; i < 120; i++) {
      if (existsSync(devtoolsFile)) {
        const line = readFileSync(devtoolsFile, 'utf8').split('\n')[0].trim()
        if (line) return Number(line)
      }
      await sleep(100)
    }
    throw new Error('DevToolsActivePort timeout\n' + chromeStderr.slice(-500))
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

  cdp = new CDP(pageWs)
  await cdp.connect()
  const errors = []
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception'))
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')) })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  console.log(`\n[real] 打开 ${DSH_URL}`)
  await cdp.send('Page.navigate', { url: DSH_URL })
  await waitFor('document.readyState === "complete"', 'document ready', 20000)
  await sleep(1200)

  /* ---- 鉴权：DSH Web 根路径需要 token（dsh web 打印的 URL），headless 无法自取 ---- */
  const authProbe = await evaluate(`(() => {
    const text = (document.body && document.body.innerText || '').slice(0, 300)
    return { title: document.title, text, htmlLength: (document.documentElement.innerHTML || '').length }
  })()`)
  if (/authentication required|Unauthorized|401/i.test(authProbe.text || '') || (authProbe.htmlLength < 2000 && !authProbe.title)) {
    await screenshot('real-00-auth-required.png')
    console.log('\n[BLOCKED] 真实 DSH 页面需要鉴权 URL：')
    console.log('  · ' + DSH_URL + ' 返回的是 "dsh web authentication required"（HTTP 401）')
    console.log('  · 请把 `dsh web` 启动时打印的完整 URL（带 token）通过 DSH_URL 传进来，例如：')
    console.log('      DSH_URL="http://127.0.0.1:61254/?token=…" node real-page.mjs')
    console.log('  · 或用登录后的桌面窗口人工复核（见 docs/CONTRACT.md §7 标注「人工」的条目）。')
    notInstalled = true
    installStateReason = 'auth-required'
    throw Object.assign(new Error('需要鉴权 URL'), { __notInstalled: true })
  }

  /* ---- 页面壳就绪 ---- */
  let shellReady = false
  try {
    await waitFor(`!!(window.__ModuleLoader__ || document.querySelector('[data-slot], main, #root, #app'))`, 'page shell', 20000)
    shellReady = true
  } catch (err) { /* 报告 */ }
  check('DSH 页面壳就绪（document + 应用挂载）', shellReady)
  if (!shellReady) throw new Error('页面壳未就绪：' + DSH_URL)

  const pageShot = await screenshot('real-00-page.png')
  check('能截到真实 DSH 页面', !!pageShot)

  /* ---- 侧栏入口 ---- */
  const entrySel = `[
    '[data-gb-entry]',
    '[aria-label*="游戏"]',
    '[aria-label*="Game" i]',
    '[data-slot="sidebar.panellist"] [aria-label*="游戏"]',
    '[title*="游戏"]'
  ].find((s) => document.querySelector(s))`
  let entryFound = null
  try {
    entryFound = await waitFor(`(() => { const sels = ${entrySel}; return sels || null })()`, 'game bench entry', 12000)
  } catch (err) { /* 未安装 */ }

  const installState = await evaluate(`(async () => {
    try {
      const r = await fetch('/game-bench/api/status')
      if (!r.ok) return { status: r.status }
      const j = await r.json()
      return { status: 200, ok: !!(j && j.ok) }
    } catch (e) { return { status: 0, error: String(e) } }
  })()`)
  const hasEntry = !!entryFound
  check('侧栏出现游戏厅入口 [data-gb-entry]（或 aria-label 含「游戏」）', hasEntry, brief(entryFound))
  if (hasEntry) {
    await screenshotRegion(entryFound, 'real-01-sidebar-entry.png', 5, 10)
  } else {
    notInstalled = true
    console.log('\n[等待 Lead 安装] 真实页面里还没有游戏厅入口。')
    console.log('  · /game-bench/api/status →', brief(installState))
    console.log('  · 请 Lead 用 plugin_manager install_bundle 安装 dsh-game-bench 后重跑本脚本。')
    throw Object.assign(new Error('插件未安装'), { __notInstalled: true })
  }

  /* ---- 打开面板 ---- */
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(entryFound)})
    if (!el) return false
    el.click()
    return true
  })()`)
  let rootReady = false
  try {
    await waitFor(`!!document.querySelector('[data-gb="root"]')`, 'game bench root', 15000)
    rootReady = true
  } catch (err) { /* 报告 */ }
  check('点击入口后主区域出现 [data-gb="root"]', rootReady)
  if (!rootReady) {
    await screenshot('real-99-no-root.png')
    throw new Error('主面板未渲染')
  }
  await sleep(1200)

  /* ---- 游戏库 ---- */
  const cards = await evaluate(`document.querySelectorAll('[data-gb-card]').length`)
  check('真实页面游戏库渲染内置卡片（≥7）', cards >= 7, `${cards} 张`)
  const covers = await evaluate(`[...document.querySelectorAll('[data-gb-card] img')].slice(0, 7).map(i => i.naturalWidth)`)
  check('真实封面图加载成功（naturalWidth > 0）', Array.isArray(covers) && covers.length > 0 && covers.every((w) => w > 0), brief(covers))
  await screenshot('real-02-library.png')

  /* ---- 播放 ---- */
  const clicked = await evaluate(`(() => {
    const el = document.querySelector('[data-gb-card]')
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  })()`)
  check('点击第一张内置卡片', clicked === true)
  let playerView = false
  try {
    await waitFor(`(() => {
      const r = document.querySelector('[data-gb="root"]')
      return !!(r && (r.getAttribute('data-gb-view') === 'player' || document.querySelector('[data-gb-start]')))
    })()`, 'player view', 12000)
    playerView = true
  } catch (err) { /* 报告 */ }
  check('进入播放器视图（含开始遮罩）', playerView, brief(await evaluate(`(() => { const r = document.querySelector('[data-gb="root"]'); return { view: r && r.getAttribute('data-gb-view'), start: !!document.querySelector('[data-gb-start]') } })()`)))
  await screenshot('real-03-player-start.png')

  if (await evaluate(`!!document.querySelector('[data-gb-start]')`)) {
    await evaluate(`document.querySelector('[data-gb-start]').click()`)
    await sleep(900)
  }
  let canvasOk = false
  try {
    await waitFor(`(() => {
      const c = document.querySelector('[data-gb="root"] canvas') || document.querySelector('canvas')
      if (!c || !c.width || !c.height) return false
      const ctx = c.getContext('2d')
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if ((d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) !== 0) n++
      return n > 500
    })()`, 'canvas non-black', 15000)
    canvasOk = true
  } catch (err) { /* 报告 */ }
  check('真实页面 canvas 出现且像素非全黑（>500）', canvasOk)
  const hash = () => evaluate(`(() => {
    const c = document.querySelector('[data-gb="root"] canvas') || document.querySelector('canvas')
    if (!c) return null
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let h = 0x811c9dc5
    for (let i = 0; i < d.length; i += 4) { const v = d[i] | (d[i + 1] << 8) | (d[i + 2] << 16); h = ((h ^ v) >>> 0); h = Math.imul(h, 0x01000193) >>> 0 }
    return h >>> 0
  })()`)
  const h1 = await hash()
  await sleep(500)
  const h2 = await hash()
  check('真实页面帧在动（两次像素哈希不同）', h1 !== null && h2 !== null && h1 !== h2, brief({ h1, h2 }))
  await screenshot('real-04-playing.png')

  // 键盘（真实页面）：派发 keydown，画面继续变化
  await evaluate(`(() => {
    const t = document.querySelector('[data-gb="root"] canvas') || document.body
    for (const key of ['ArrowRight', 'z']) {
      t.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'z' ? 'KeyZ' : key, bubbles: true }))
    }
    return true
  })()`)
  await sleep(500)
  const h3 = await hash()
  check('真实页面按键后画面继续变化', h3 !== null && h2 !== null && h3 !== h2, brief({ h2, h3 }))
  await screenshot('real-05-after-keys.png')

  check('真实页面运行期无未捕获异常（游戏厅相关 console.error）', errors.filter((e) => /game-bench|GameBench|GB/i.test(String(e))).length === 0, brief(errors.slice(0, 3)))

} catch (err) {
  if (!err.__notInstalled) {
    fatal = err
    failures.push({ label: `FATAL: ${err.message}`, extra: undefined })
    console.error('\nFATAL:', err.stack || err)
  }
} finally {
  console.log('\n================ 真实页面验收结果 ================')
  if (notInstalled) {
    if (installStateReason === 'auth-required') {
      console.log('BLOCKED：真实页面需要带 token 的 DSH Web URL（向 Lead 索取后再跑）')
    } else {
      console.log('BLOCKED：插件尚未安装到真实 DSH 页面（等待 Lead 安装后重跑）')
    }
    console.log('  不作为 FAIL 计；退出码 2。')
  } else {
    console.log(`PASS ${passed.length} / FAIL ${failures.length}${fatal ? '（含 FATAL）' : ''}`)
    if (failures.length) {
      console.log('\nFAIL 清单：')
      for (const f of failures) console.log(`  ✗ ${f.label}${f.extra === undefined ? '' : ` → ${typeof f.extra === 'string' ? f.extra : JSON.stringify(f.extra)}`}`)
    }
  }
  if (shots.length) { console.log('\n截图：'); for (const s of shots) console.log('  ' + s) }
  const log = [
    `# dsh-game-bench real-page ${new Date().toISOString()}`,
    `url: ${DSH_URL}`,
    notInstalled ? (`BLOCKED: ${installStateReason === 'auth-required' ? '真实页面需要鉴权 URL' : '插件未安装（等待 Lead）'}`) : `PASS ${passed.length} / FAIL ${failures.length}${fatal ? '（含 FATAL）' : ''}`,
    '',
    '## PASS',
    ...passed.map((p) => `- ${p}`),
    '',
    '## FAIL',
    ...failures.map((f) => `- ${f.label}${f.extra === undefined ? '' : ` → ${typeof f.extra === 'string' ? f.extra : JSON.stringify(f.extra)}`}`),
    '',
    '## SHOTS',
    ...shots.map((s) => `- ${s}`),
  ].join('\n')
  writeFileSync(join(HERE, 'real-page.log'), log)
  clearTimeout(watchdog)
  try { cdp && cdp.close() } catch { /* ignore */ }
  try { chrome.kill('SIGKILL') } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(notInstalled ? 2 : failures.length ? 1 : 0)
}
