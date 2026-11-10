#!/usr/bin/env node
/**
 * 拾光游戏厅（Game Bench）client 离线验收后端
 *
 * 只服务 dsh-game-bench/selftest，不碰插件源码：
 *  - 静态服务：harness.html / ../client.js / React 18 UMD（assets/）
 *  - 完整 mock /game-bench/api/*（严格按 docs/API.md 的信封与形状）
 *  - 真实素材：
 *      · 内置 7 款 → ../games/builtin.json + 真实 .nes / .png
 *      · 市场切片 96 款 → ../../.lead-tmp/gb/library（catalog.json / store.json / owned/*.nes / covers|legacy-images）
 *    /rom/<id> 返回真实 ROM 字节；/cover/<id> 返回真实 PNG（找不到 404）。
 *  - 市场安装：POST /install 延迟 300ms 后加入 library（内存态，进程结束即失效）
 *  - 运行时文件：/game-bench/api/vendor/jsnes.js + /game-bench/api/engine.js（文件存在才 200，否则 404）
 *  - 失败模式（POST /__config 或 harness.html?mode=）：
 *      mode=auth    → /market /catalog 返回 401 AUTH
 *      mode=offline → /market /catalog 返回 502 NETWORK
 *      mode=slow    → /library /catalog /market 延迟 1500ms（验证加载态）
 *  - 控制面：POST /__config、GET /__calls、POST /__clearcalls、POST /__reset、GET /__health、GET /__artifacts
 *
 * 用法：node server.mjs                       （随机端口，stdout 打印 {"port":N}）
 *       GB_CLIENT=/abs/path.js node server.mjs   覆盖 client.js 路径（基础设施自测用）
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const WORKSPACE = join(PLUGIN, '..')
const LIBRARY = join(WORKSPACE, '.lead-tmp', 'gb', 'library')

const CLIENT = process.env.GB_CLIENT ? resolve(process.env.GB_CLIENT) : join(PLUGIN, 'client.js')
const ENGINE = process.env.GB_ENGINE ? resolve(process.env.GB_ENGINE) : join(PLUGIN, 'engine.js')
const JSNES = process.env.GB_JSNES ? resolve(process.env.GB_JSNES) : join(PLUGIN, 'vendor', 'jsnes.min.js')
const GAMEPADS = process.env.GB_GAMEPADS ? resolve(process.env.GB_GAMEPADS) : join(PLUGIN, 'gamepads.js')
const GAMEPAD_SETTINGS = process.env.GB_GAMEPAD_SETTINGS ? resolve(process.env.GB_GAMEPAD_SETTINGS) : join(PLUGIN, 'gamepad-settings.js')
const GAMES = join(PLUGIN, 'games')

const API = '/game-bench/api'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/* ------------------------------------------------------------------ *
 * 配置（POST /__config 可改）
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  mode: null,        // null | 'auth' | 'offline' | 'slow'
  installDelay: 300, // POST /install 延迟（ms）
  installFail: null, // null | 'sha' | 'network'
  syncFail: false,
  emptyLibrary: false,
}
const cfg = { ...DEFAULTS }
let calls = []

/* ------------------------------------------------------------------ *
 * 内置 7 款（真实 ROM/封面）
 * ------------------------------------------------------------------ */
/* 与 Host 一致：public builtin.json（可分发 demo）+ games/builtin.local.json（本机私有 7 款，
   被 .gitignore 排除）合并，同 id 时 local 覆盖 public，且只保留 ROM/封面真实存在的条目。 */
function readManifest(file, optional = false) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch {
    if (optional && !existsSync(file)) return null
    throw new Error('读取内置清单失败：' + file)
  }
}
const publicDoc = readManifest(join(GAMES, 'builtin.json'))
const localDoc = readManifest(join(GAMES, 'builtin.local.json'), true)
const BUILTIN = (() => {
  const byId = new Map()
  for (const doc of [publicDoc, localDoc]) {
    for (const g of (doc && doc.games) || []) {
      if (!g || !g.id) continue
      byId.set(g.id, {
        id: g.id,
        title: g.title,
        file: g.file,
        coverFile: g.cover,
        sha256: g.sha256,
        size: g.size || 0,
        source: g.source || '',
        sourceNames: g.sourceNames || [g.title],
        language: g.language || '',
        tags: g.tags || [],
        series: g.series || '',
        featuredRank: g.featuredRank || 0,
      })
    }
  }
  return [...byId.values()]
    .filter((g) => g.file && existsSync(join(GAMES, g.file)))
    .filter((g) => !g.coverFile || existsSync(join(GAMES, g.coverFile)))
    .sort((a, b) => (a.featuredRank || 0) - (b.featuredRank || 0) || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'))
})()
const BUILTIN_IDS = new Set(BUILTIN.map((g) => g.id))

/* ------------------------------------------------------------------ *
 * 市场切片（真实资源库副本）
 * ------------------------------------------------------------------ */
function readJsonIf(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
const CATALOG_RAW = readJsonIf(join(LIBRARY, 'catalog.json'), [])
const STORE_RAW = readJsonIf(join(LIBRARY, 'store.json'), { collections: [] })

const assetPath = (rel) => (rel ? join(LIBRARY, rel) : '')
const existsAsset = (rel) => !!rel && existsSync(assetPath(rel))

function coverRel(entry) {
  if (existsAsset(entry.cover)) return entry.cover
  if (entry.legacyCoverID && existsAsset(`legacy-images/${entry.legacyCoverID}.png`)) return `legacy-images/${entry.legacyCoverID}.png`
  return ''
}

const CATALOG = CATALOG_RAW
  .filter((g) => g && g.system === 'nes' && existsAsset(g.filename))
  .map((g) => ({ ...g, _coverRel: coverRel(g) }))

/** 市场 = 非内置 + 有真实资产；「魂斗罗/坦克」等可搜索项前置。切片 96 款，确定性。 */
const MARKET_SLICE = (() => {
  const pool = CATALOG.filter((g) => !BUILTIN_IDS.has(g.id) && g._coverRel)
  const byId = new Map(pool.map((g) => [g.id, g]))
  const seen = new Set()
  const out = []
  const push = (g) => { if (g && !seen.has(g.id) && out.length < 96) { seen.add(g.id); out.push(g) } }
  // 1) 先按合集各取 12 款，保证市场首页 7 个合集 chips 都有足量真实游戏
  for (const col of STORE_RAW.collections || []) {
    let taken = 0
    for (const id of col.gameIDs || []) {
      if (taken >= 12) break
      const g = byId.get(id)
      if (g) { push(g); taken += 1 }
    }
  }
  // 2) 可搜索锚点（魂斗罗 / 坦克 …）
  for (const g of pool) if (/坦克|魂斗罗|超级玛丽|冒险岛|双截龙|热血/.test(g.title)) push(g)
  // 3) 其余按目录顺序补齐
  for (const g of pool) push(g)
  return out
})()
const MARKET_IDS = new Set(MARKET_SLICE.map((g) => g.id))

/* 合集：store.json 的 gameIDs ∩ 市场切片（保持合集内顺序） */
const COLLECTIONS = (STORE_RAW.collections || [])
  .map((c) => ({
    id: c.id,
    title: c.title || c.id,
    description: c.description || '',
    ids: (c.gameIDs || []).filter((id) => MARKET_IDS.has(id)),
  }))
  .filter((c) => c.ids.length >= 4)

const LIBRARY_VERSION = STORE_RAW.libraryVersion || '2026-11-06'
const MARKET_TITLE = STORE_RAW.title || '拾光游戏市场'
const CATALOG_TOTAL = MARKET_SLICE.length

/* ------------------------------------------------------------------ *
 * 运行时状态：已安装市场游戏 / 设置
 * ------------------------------------------------------------------ */
const installed = new Map() // id -> installedAt
const saveSettings = { repo: 'zeelinkCN/game-bench-library', token: '' }
let lastSync = 1762000000000

function resetState() {
  installed.clear()
  cfg.mode = DEFAULTS.mode
  cfg.installDelay = DEFAULTS.installDelay
  cfg.installFail = null
  cfg.syncFail = false
  cfg.emptyLibrary = false
  saveSettings.repo = 'zeelinkCN/game-bench-library'
  saveSettings.token = ''
  lastSync = 1762000000000
  calls = []
}

const coverUrl = (id) => `${API}/cover/${id}`
const romUrl = (id) => `${API}/rom/${id}`

function builtinGame(g) {
  return {
    id: g.id,
    title: g.title,
    cover: coverUrl(g.id),
    rom: romUrl(g.id),
    builtin: true,
    installed: true,
    size: g.size,
    sha256: g.sha256,
    source: g.source,
    sourceNames: g.sourceNames,
    language: g.language,
    tags: g.tags,
    series: g.series,
    featuredRank: g.featuredRank,
  }
}

function marketEntry(g) {
  return {
    id: g.id,
    title: g.title,
    cover: coverUrl(g.id),
    sha256: g.sha256,
    source: g.source || '',
    sourceNames: g.sourceNames || [g.title],
    language: g.language || '',
    series: g.series || '',
    builtin: false,
    installed: installed.has(g.id),
  }
}

function marketGame(g) {
  return {
    id: g.id,
    title: g.title,
    cover: coverUrl(g.id),
    rom: romUrl(g.id),
    builtin: false,
    installed: true,
    size: g.size || 0,
    sha256: g.sha256,
    source: g.source || '',
    sourceNames: g.sourceNames || [g.title],
    language: g.language || '',
    tags: g.tags || [],
    series: g.series || '',
    featuredRank: 0,
  }
}

function libraryGames() {
  const list = cfg.emptyLibrary ? [] : BUILTIN.map(builtinGame)
  const extra = [...installed.entries()].sort((a, b) => b[1] - a[1])
  for (const [id] of extra) {
    const g = MARKET_SLICE.find((x) => x.id === id)
    if (g) list.push(marketGame(g))
  }
  return list
}

function statusPayload() {
  const authBlocked = cfg.mode === 'auth'
  const offline = cfg.mode === 'offline'
  return {
    version: '1.1.0',
    builtinCount: BUILTIN.length,
    installedCount: installed.size,
    dataDir: '/tmp/game-bench-selftest-data',
    market: {
      repo: saveSettings.repo,
      auth: authBlocked ? 'none' : saveSettings.token ? 'settings' : 'gh',
      ready: !authBlocked && !offline,
      catalogGames: CATALOG.length,
      lastSync,
      error: authBlocked
        ? '市场需要 GitHub 访问权限，请在设置里粘贴 Token，或先执行 gh auth login'
        : offline
          ? '连不上 GitHub，请检查网络后重试（内置游戏不受影响）'
          : null,
    },
    vendor: {
      jsnes: existsSync(JSNES),
      engine: existsSync(ENGINE),
      gamepads: existsSync(GAMEPADS),
      gamepadSettings: existsSync(GAMEPAD_SETTINGS),
    },
  }
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */
function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}
function json(res, status, obj, extra = {}) {
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  }, JSON.stringify(obj))
}
const ok = (res, data) => json(res, 200, { ok: true, data })
function fail(res, code, message, status = 502) {
  json(res, status, { ok: false, error: message, code }, {})
}
function staticFile(res, file, type, cache = 'no-store') {
  if (!existsSync(file)) return false
  const body = readFileSync(file)
  send(res, 200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache }, body)
  return true
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}
function recordCall(req, pathname, search) {
  calls.push({ method: req.method, path: pathname, search: search || '', at: Date.now() })
}

const MARKET_ERR = {
  auth: { status: 401, code: 'AUTH', error: '市场需要 GitHub 访问权限，请在设置里粘贴 Token，或先执行 gh auth login' },
  offline: { status: 502, code: 'NETWORK', error: '连不上 GitHub，请检查网络后重试（内置游戏不受影响）' },
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
async function handleApi(req, res, path, params) {
  const method = req.method || 'GET'

  if (path === `${API}/status`) return ok(res, statusPayload())

  /* ---- 运行时文件 ---- */
  if (path === `${API}/vendor/jsnes.js`) {
    const served = staticFile(res, JSNES, 'application/javascript; charset=utf-8', 'public, max-age=604800')
    if (!served) fail(res, 'NOT_FOUND', '缺少 jsnes 运行时', 404)
    return
  }
  if (path === `${API}/engine.js`) {
    const served = staticFile(res, ENGINE, 'application/javascript; charset=utf-8', 'public, max-age=604800')
    if (!served) fail(res, 'NOT_FOUND', '缺少模拟器封装 engine.js', 404)
    return
  }
  if (path === `${API}/gamepads.js`) {
    const served = staticFile(res, GAMEPADS, 'application/javascript; charset=utf-8', 'public, max-age=604800')
    if (!served) fail(res, 'NOT_FOUND', '缺少手柄模块 gamepads.js', 404)
    return
  }
  if (path === `${API}/gamepad-settings.js`) {
    const served = staticFile(res, GAMEPAD_SETTINGS, 'application/javascript; charset=utf-8', 'public, max-age=604800')
    if (!served) fail(res, 'NOT_FOUND', '缺少手柄设置模块 gamepad-settings.js', 404)
    return
  }

  /* ---- 失败模式（市场/目录） ---- */
  const modeErr = cfg.mode === 'auth' ? MARKET_ERR.auth : cfg.mode === 'offline' ? MARKET_ERR.offline : null
  if (cfg.mode === 'slow' && ['/library', '/catalog', '/market'].some((p) => path === `${API}${p}`)) {
    await sleep(1500)
  }

  if (path === `${API}/library`) {
    const games = libraryGames()
    return ok(res, {
      builtinCount: cfg.emptyLibrary ? 0 : BUILTIN.length,
      installedCount: installed.size,
      games,
    })
  }

  if (path === `${API}/catalog`) {
    if (modeErr) return fail(res, modeErr.code, modeErr.error, modeErr.status)
    const q = (params.get('q') || '').trim().toLowerCase()
    const collection = params.get('collection') || ''
    const offset = Math.max(0, Number(params.get('offset') || 0) || 0)
    const limit = Math.min(200, Math.max(1, Number(params.get('limit') || 60) || 60))
    let pool = MARKET_SLICE
    if (collection) {
      const col = COLLECTIONS.find((c) => c.id === collection)
      pool = col ? col.ids.map((id) => MARKET_SLICE.find((g) => g.id === id)).filter(Boolean) : []
    }
    if (q) {
      pool = pool.filter((g) =>
        String(g.title).toLowerCase().includes(q) ||
        (g.sourceNames || []).some((n) => String(n).toLowerCase().includes(q)))
    }
    return ok(res, {
      total: q || collection ? pool.length : CATALOG_TOTAL,
      offset,
      limit,
      items: pool.slice(offset, offset + limit).map(marketEntry),
    })
  }

  if (path === `${API}/market`) {
    if (modeErr) return fail(res, modeErr.code, modeErr.error, modeErr.status)
    const collections = COLLECTIONS.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      total: c.ids.length,
      games: c.ids.slice(0, 8).map((id) => marketEntry(MARKET_SLICE.find((g) => g.id === id))).filter(Boolean),
    }))
    const featured = MARKET_SLICE.slice(0, 12).map(marketEntry)
    return ok(res, {
      title: MARKET_TITLE,
      libraryVersion: LIBRARY_VERSION,
      total: CATALOG_TOTAL,
      auth: cfg.mode === 'auth' ? 'none' : saveSettings.token ? 'settings' : 'gh',
      collections,
      featured,
    })
  }

  if (path === `${API}/install` && method === 'POST') {
    if (cfg.mode === 'offline') return fail(res, 'NETWORK', MARKET_ERR.offline.error, 502)
    const body = await readBody(req)
    const id = String(body.id || '')
    const game = MARKET_SLICE.find((g) => g.id === id)
    if (!game) return fail(res, 'NOT_FOUND', '找不到这款游戏，可能已从资源库移除', 404)
    if (cfg.installFail === 'network') return fail(res, 'NETWORK', '下载中断，请重试', 502)
    if (cfg.installFail === 'sha') {
      return fail(res, 'SHA_MISMATCH', `文件校验失败，已删除半成品，请重试（期望 ${game.sha256.slice(0, 12)}，实际 deadbeef0000）`, 200)
    }
    await sleep(cfg.installDelay)
    if (!installed.has(id)) installed.set(id, Date.now())
    return ok(res, { game: marketGame(game), bytes: game.size || 0, cover: !!game._coverRel })
  }

  if (path === `${API}/uninstall` && method === 'POST') {
    const body = await readBody(req)
    const id = String(body.id || '')
    if (BUILTIN_IDS.has(id)) return fail(res, 'BAD_REQUEST', '内置游戏不可卸载', 400)
    const removed = installed.delete(id)
    return ok(res, { id, removed })
  }

  if (path.startsWith(`${API}/rom/`)) {
    const id = decodeURIComponent(path.slice(`${API}/rom/`.length))
    const b = BUILTIN.find((g) => g.id === id)
    const file = b ? join(GAMES, b.file) : join(LIBRARY, (MARKET_SLICE.find((g) => g.id === id) || {}).filename || '')
    if (!file || !existsSync(file)) return fail(res, 'NOT_FOUND', '找不到这款游戏，可能已从资源库移除', 404)
    const body = readFileSync(file)
    return send(res, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    }, body)
  }

  if (path.startsWith(`${API}/cover/`)) {
    const id = decodeURIComponent(path.slice(`${API}/cover/`.length))
    const b = BUILTIN.find((g) => g.id === id)
    let file = b ? join(GAMES, b.coverFile) : ''
    if (!file) {
      const g = MARKET_SLICE.find((x) => x.id === id)
      if (g && g._coverRel) file = assetPath(g._coverRel)
    }
    if (!file || !existsSync(file)) return fail(res, 'NOT_FOUND', '封面不存在', 404)
    const body = readFileSync(file)
    return send(res, 200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=604800',
    }, body)
  }

  if (path === `${API}/settings`) {
    if (method === 'POST') {
      const body = await readBody(req)
      if (typeof body.repo === 'string') {
        if (!/^[\w.-]+\/[\w.-]+$/.test(body.repo)) return fail(res, 'BAD_REQUEST', '仓库格式必须是 owner/name', 400)
        saveSettings.repo = body.repo
      }
      if (typeof body.token === 'string') saveSettings.token = body.token
      return ok(res, {
        repo: saveSettings.repo,
        hasToken: !!saveSettings.token,
        tokenSource: saveSettings.token ? 'settings' : 'gh',
        dataDir: '/tmp/game-bench-selftest-data',
      })
    }
    return ok(res, {
      repo: saveSettings.repo,
      hasToken: !!saveSettings.token,
      tokenSource: saveSettings.token ? 'settings' : 'gh',
      dataDir: '/tmp/game-bench-selftest-data',
    })
  }

  if (path === `${API}/sync` && method === 'POST') {
    if (cfg.syncFail || cfg.mode === 'offline') {
      return fail(res, 'NETWORK', '连不上 GitHub，请检查网络后重试（内置游戏不受影响）', 502)
    }
    if (cfg.mode === 'auth') return fail(res, 'AUTH', MARKET_ERR.auth.error, 401)
    lastSync = Date.now()
    return ok(res, {
      total: CATALOG.length,
      collections: COLLECTIONS.length,
      lastSync,
      auth: saveSettings.token ? 'settings' : 'gh',
    })
  }

  return fail(res, 'NOT_FOUND', `未知接口 ${path}`, 404)
}

/* ------------------------------------------------------------------ *
 * 静态：harness.html（按工件存在情况注入 engine 预加载脚本）
 * ------------------------------------------------------------------ */
function harnessHtml() {
  let html = readFileSync(join(HERE, 'harness.html'), 'utf8')
  const tags = []
  if (existsSync(JSNES) && existsSync(ENGINE)) {
    tags.push(`<script src="${API}/vendor/jsnes.js"></script>`)
    tags.push(`<script src="${API}/engine.js"></script>`)
  }
  return html.replace('<!--GB_ENGINE_SCRIPTS-->', tags.join('\n  '))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname)
    recordCall(req, path, url.search)

    if (path === '/__health') return json(res, 200, { ok: true, mode: cfg.mode, pid: process.pid })
    if (path === '/__artifacts') {
      return json(res, 200, {
        client: existsSync(CLIENT), engine: existsSync(ENGINE), jsnes: existsSync(JSNES),
        gamepads: existsSync(GAMEPADS), gamepadSettings: existsSync(GAMEPAD_SETTINGS),
        games: existsSync(GAMES), library: existsSync(LIBRARY),
        builtin: BUILTIN.length, market: MARKET_SLICE.length, collections: COLLECTIONS.length,
      })
    }
    if (path === '/__config') {
      if (req.method === 'POST') {
        const body = await readBody(req)
        for (const k of Object.keys(DEFAULTS)) if (k in body) cfg[k] = body[k]
        return json(res, 200, { ok: true, config: cfg })
      }
      return json(res, 200, { ok: true, config: cfg })
    }
    if (path === '/__calls') return json(res, 200, calls)
    if (path === '/__clearcalls') { calls = []; return json(res, 200, { ok: true }) }
    if (path === '/__reset') { resetState(); return json(res, 200, { ok: true, config: cfg }) }

    if (path === '/' || path === '/harness.html') {
      return send(res, 200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }, harnessHtml())
    }
    if (path === '/client.js') {
      if (!staticFile(res, CLIENT, MIME['.js'])) return fail(res, 'NOT_FOUND', 'client.js 未交付', 404)
      return
    }
    if (path === '/react.js') return staticFile(res, join(HERE, 'assets', 'react.js'), MIME['.js'], 'public, max-age=86400')
    if (path === '/react-dom.js') return staticFile(res, join(HERE, 'assets', 'react-dom.js'), MIME['.js'], 'public, max-age=86400')
    if (path === '/assets/icon-256.png' && staticFile(res, join(PLUGIN, 'assets', 'icon-256.png'), MIME['.png'], 'public, max-age=604800')) return

    if (path.startsWith(API)) return await handleApi(req, res, path, url.searchParams)

    return fail(res, 'NOT_FOUND', `未知路径 ${path}`, 404)
  } catch (err) {
    try { fail(res, 'INTERNAL', `mock server 异常：${err && err.message}`, 500) } catch { /* ignore */ }
  }
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  console.log(JSON.stringify({
    port,
    client: CLIENT,
    engine: existsSync(ENGINE),
    jsnes: existsSync(JSNES),
    gamepads: existsSync(GAMEPADS),
    gamepadSettings: existsSync(GAMEPAD_SETTINGS),
    builtin: BUILTIN.length,
    market: MARKET_SLICE.length,
    collections: COLLECTIONS.map((c) => `${c.id}:${c.ids.length}`).join(','),
  }))
})
