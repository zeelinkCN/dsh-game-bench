/**
 * HTTP 层：路由注册表 + JSON 信封 + 二进制路由（ROM / 封面 / 前端运行时）。
 *
 * 职责：
 *  - 把 market / store / builtin 的能力映射成 /game-bench/api/* 接口
 *  - 统一 { ok:true, data } / { ok:false, error, code } 信封与 HTTP 状态码
 *  - /status 永远 200（内部任何异常都降级成兜底数据），保证面板健康检查不炸
 *  - 二进制路由（/rom/<id>、/cover/<id>、/vendor/jsnes.js、/engine.js）不套 JSON
 *
 * 上游：market（GitHub 资源库 + 本地缓存）、store（本地文件）、builtin（随包清单）
 * 降级：单个接口失败只影响该接口；静态运行时文件缺失返回 404 而不是让插件挂掉
 */
import { existsSync } from 'node:fs'
import { ERROR_TEXT, GameBenchError, errorText, isKnownCode, statusFor } from './errors.mjs'
import { readFileSafe } from './fsutil.mjs'
import { invalidateAuth, peekAuth, resolveAuth } from './github.mjs'
import {
  DEFAULT_REPO,
  ENGINE_FILE,
  GAMEPADS_FILE,
  GAMEPAD_SETTINGS_FILE,
  ID_RE,
  ROUTE,
  VENDOR_FILE,
  VERSION,
  dataDir,
} from './paths.mjs'

/** 二进制路由 id：市场游戏 nes-<sha256>，内置 demo 允许 starpilot 这类安全短 id */
const SAFE_ROUTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
import { REPO_RE } from './store.mjs'

/* ------------------------------------------------------------------ *
 * 通用响应工具
 * ------------------------------------------------------------------ */

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

const clampInt = (raw, fallback, min, max) => {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const sendJson = (res, payload, statusCode = 200) => {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

const ok = (res, data) => sendJson(res, { ok: true, data }, 200)

const fail = (res, error, fallbackCode = 'INTERNAL') => {
  const code = error instanceof GameBenchError ? error.code : isKnownCode(error?.code) ? error.code : fallbackCode
  const safeCode = isKnownCode(code) ? code : 'INTERNAL'
  let message = typeof error === 'string' ? error : str(error?.message).trim()
  if (!message) message = errorText(safeCode)
  if (safeCode === 'INTERNAL' && !message.startsWith('出现意外错误')) {
    message = `出现意外错误：${message}`
  }
  sendJson(res, { ok: false, error: message, code: safeCode }, statusFor(safeCode))
}

/** 读取 JSON 请求体（上限 64KB） */
const readJsonBody = (req, limit = 64 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new GameBenchError('请求体过大', 'BAD_REQUEST'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new GameBenchError('请求体不是合法的 JSON', 'BAD_REQUEST'))
      }
    })
    req.on('error', (err) => reject(new GameBenchError(`读取请求体失败：${str(err?.message).slice(0, 80)}`, 'BAD_REQUEST')))
  })

const requirePost = (req) => {
  const method = str(req.method).toUpperCase()
  if (method && method !== 'POST') throw new GameBenchError('该接口只接受 POST 请求', 'BAD_REQUEST')
}

const safeUrl = (req) => {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    return new URL('/', 'http://127.0.0.1')
  }
}

/** 给 Promise 加超时（/status 用，避免首次解析 gh token 拖慢健康检查） */
const withBudget = async (promise, ms, fallback) => {
  let timer = null
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
      timer.unref?.()
    })
    const result = await Promise.race([promise, timeout])
    return result ?? fallback
  } catch {
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 从 /rom/<id> 这类前缀路由里取出并校验 id */
const idFromPrefix = (pathname, prefix) => {
  if (!pathname.startsWith(`${prefix}/`)) return ''
  let raw = pathname.slice(prefix.length + 1)
  try {
    raw = decodeURIComponent(raw)
  } catch {
    return ''
  }
  raw = raw.replace(/\/+$/, '')
  if (raw.includes('/')) return ''
  return SAFE_ROUTE_ID_RE.test(raw) ? raw : ''
}

/** tags 合并：内置清单里的 tags 优先，再接市场合集名，最多 3 个 */
const mergeTags = (manifestTags, collectionTags) => {
  const out = []
  for (const tag of [...(Array.isArray(manifestTags) ? manifestTags : []), ...(Array.isArray(collectionTags) ? collectionTags : [])]) {
    const text = str(tag).trim()
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= 3) break
  }
  return out
}

const sendBinary = (res, statusCode, contentType, body, cacheControl) => {
  if (res.writableEnded) return
  res.statusCode = statusCode
  if (contentType) res.setHeader('Content-Type', contentType)
  if (cacheControl) res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

const sendCoverNotFound = (res) => {
  if (res.writableEnded) return
  res.statusCode = 404
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

/** 前端运行时静态文件（文件缺失时返回 404 空脚本，前端显示「模拟器运行时缺失」） */
const serveRuntimeScript = async (res, file, log) => {
  const bytes = await readFileSafe(file)
  if (!bytes) {
    log('运行时文件缺失（返回 404）', file.split('/').slice(-2).join('/'))
    sendBinary(res, 404, 'application/javascript; charset=utf-8', Buffer.from('// 模拟器运行时文件缺失\n', 'utf8'), 'no-store')
    return
  }
  sendBinary(res, 200, 'application/javascript; charset=utf-8', bytes, 'public, max-age=604800')
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   log: (...args: any[]) => void,
 *   builtin: ReturnType<import('./builtin.mjs').createBuiltin>,
 *   store: ReturnType<import('./store.mjs').createStore>,
 *   market: ReturnType<import('./market.mjs').createMarket>,
 * }} deps
 */
export function createRoutes({ log, builtin, store, market }) {
  /** 首次调 /status 时鉴权解析最多等 4.5s，超时先用缓存/unknown */
  const authWithBudget = async (repo) => {
    try {
      const resolved = await withBudget(resolveAuth({ repo, log }), 4500, null)
      return resolved || peekAuth() || { kind: 'none', token: '' }
    } catch (err) {
      log('鉴权解析失败（降级）', str(err?.message).slice(0, 120))
      return peekAuth() || { kind: 'none', token: '' }
    }
  }

  const buildStatus = async () => {
    const settings = await store.readSettings()
    const repo = store.repoOf(settings)
    const authInfo = await authWithBudget(repo)
    const builtinGames = builtin.list()
    const builtinIds = new Set(builtinGames.map((game) => game.id))
    let library = { games: [] }
    try {
      library = await store.readLibrary()
    } catch (err) {
      log('读取游戏库失败（降级为空）', str(err?.message).slice(0, 120))
    }
    const installedCount = library.games.filter((game) => !builtinIds.has(game.id)).length
    const peek = await market.peekStatus()
    return {
      version: VERSION,
      builtinCount: builtinGames.length,
      installedCount,
      dataDir: dataDir(),
      market: {
        repo,
        auth: authInfo.kind,
        ready: peek.ready,
        catalogGames: peek.count,
        lastSync: peek.lastSync,
        error: market.lastError() || null,
      },
      vendor: {
        jsnes: existsSync(VENDOR_FILE),
        engine: existsSync(ENGINE_FILE),
        gamepads: existsSync(GAMEPADS_FILE),
        gamepadSettings: existsSync(GAMEPAD_SETTINGS_FILE),
      },
    }
  }

  const statusFallback = () => {
    let builtinCount = 0
    try {
      builtinCount = builtin.list().length
    } catch {
      /* 保持 0 */
    }
    return {
      version: VERSION,
      builtinCount,
      installedCount: 0,
      dataDir: dataDir(),
      market: {
        repo: DEFAULT_REPO,
        auth: peekAuth()?.kind || 'none',
        ready: false,
        catalogGames: 0,
        lastSync: null,
        error: '状态检查暂时不可用',
      },
      vendor: { jsnes: false, engine: false, gamepads: false, gamepadSettings: false },
    }
  }

  const makeRoute = (name, handler, kind = 'exact') => ({
    kind,
    path: `${ROUTE}/${name}`,
    handler: async (req, res) => {
      try {
        await handler(safeUrl(req), req, res)
      } catch (err) {
        if (res.writableEnded) return
        fail(res, err, 'INTERNAL')
        if (!(err instanceof GameBenchError) || err.code === 'INTERNAL') {
          log('接口异常', name, str(err?.message ?? err).slice(0, 160))
        }
      }
    },
  })

  const routes = []
  const add = (name, handler, kind = 'exact') => {
    routes.push(makeRoute(name, handler, kind))
  }

  /* ---- 1. 状态 ---- */
  add('status', async (url, req, res) => {
    let data
    try {
      data = await buildStatus()
    } catch (err) {
      log('status 构建失败，返回兜底数据', str(err?.message ?? err).slice(0, 160))
      data = statusFallback()
    }
    ok(res, data)
  })

  /* ---- 2. 游戏库 ---- */
  add('library', async (url, req, res) => {
    const builtinGames = builtin.list()
    const builtinIds = new Set(builtinGames.map((game) => game.id))
    let library = { games: [] }
    try {
      library = await store.readLibrary()
    } catch (err) {
      log('读取游戏库失败（降级为空）', str(err?.message).slice(0, 120))
    }

    // tags 来自市场合集（只读本地磁盘缓存，不联网）
    const tagsById = new Map()
    try {
      const collections = await market.peekCollections()
      for (const collection of collections) {
        const ids = Array.isArray(collection?.gameIDs) ? collection.gameIDs : []
        const title = str(collection?.title).trim()
        if (!title) continue
        for (const id of ids) {
          const key = String(id)
          const list = tagsById.get(key) || []
          if (list.length < 3 && !list.includes(title)) list.push(title)
          tagsById.set(key, list)
        }
      }
    } catch (err) {
      log('合集标签计算失败（降级为空）', str(err?.message).slice(0, 120))
    }

    const installedGames = library.games
      .filter((game) => !builtinIds.has(game.id))
      .sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0))

    const games = [
      ...builtinGames.map((game) => ({
        id: game.id,
        title: game.title,
        cover: `${ROUTE}/cover/${game.id}`,
        rom: `${ROUTE}/rom/${game.id}`,
        builtin: true,
        installed: true,
        size: game.size,
        sha256: game.sha256,
        source: game.source,
        sourceNames: game.sourceNames,
        language: game.language,
        tags: mergeTags(game.tags, tagsById.get(game.id)),
        series: game.series,
        featuredRank: game.featuredRank,
      })),
      ...installedGames.map((game) => ({
        id: game.id,
        title: game.title,
        cover: `${ROUTE}/cover/${game.id}`,
        rom: `${ROUTE}/rom/${game.id}`,
        builtin: false,
        installed: true,
        size: game.size,
        sha256: game.sha256,
        source: game.source,
        sourceNames: game.sourceNames,
        language: game.language,
        tags: mergeTags([], tagsById.get(game.id)),
        series: game.series,
        featuredRank: 0,
      })),
    ]

    ok(res, { builtinCount: builtinGames.length, installedCount: installedGames.length, games })
  })

  /* ---- 3. 市场目录 ---- */
  add('catalog', async (url, req, res) => {
    const q = str(url.searchParams.get('q')).trim()
    const collection = str(url.searchParams.get('collection')).trim()
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1000000)
    const limit = clampInt(url.searchParams.get('limit'), 60, 1, 120)
    try {
      ok(res, await market.queryCatalog({ q, collection, offset, limit }))
    } catch (err) {
      fail(res, err, 'NETWORK')
    }
  })

  /* ---- 4. 市场首页 ---- */
  add('market', async (url, req, res) => {
    try {
      ok(res, await market.getMarketHome())
    } catch (err) {
      fail(res, err, 'NETWORK')
    }
  })

  /* ---- 5. 安装 ---- */
  add('install', async (url, req, res) => {
    requirePost(req)
    const body = await readJsonBody(req)
    const id = str(body.id).trim()
    if (!ID_RE.test(id)) throw new GameBenchError('游戏 id 格式不正确（应为 nes-<sha256>）', 'BAD_REQUEST')
    try {
      ok(res, await market.install(id))
    } catch (err) {
      fail(res, err, 'INTERNAL')
    }
  })

  /* ---- 6. 卸载 ---- */
  add('uninstall', async (url, req, res) => {
    requirePost(req)
    const body = await readJsonBody(req)
    const id = str(body.id).trim()
    if (!ID_RE.test(id)) throw new GameBenchError('游戏 id 格式不正确（应为 nes-<sha256>）', 'BAD_REQUEST')
    try {
      ok(res, await market.uninstall(id))
    } catch (err) {
      fail(res, err, 'INTERNAL')
    }
  })

  /* ---- 7. ROM（二进制，前缀路由） ---- */
  add(
    'rom',
    async (url, req, res) => {
      const id = idFromPrefix(url.pathname, `${ROUTE}/rom`)
      const notFound = () => fail(res, new GameBenchError(ERROR_TEXT.NOT_FOUND, 'NOT_FOUND'), 'NOT_FOUND')
      if (!id) return notFound()
      const found = await market.findRom(id)
      if (!found) return notFound()
      const bytes = await readFileSafe(found.path)
      if (!bytes) return notFound()
      sendBinary(
        res,
        200,
        'application/octet-stream',
        bytes,
        found.builtin ? 'private, max-age=86400' : 'no-store',
      )
    },
    'prefix',
  )

  /* ---- 8. 封面（二进制，前缀路由；内置 -> 本地缓存 -> 懒加载） ---- */
  add(
    'cover',
    async (url, req, res) => {
      const id = idFromPrefix(url.pathname, `${ROUTE}/cover`)
      if (!id) return sendCoverNotFound(res)
      let found = await market.findLocalCover(id)
      if (!found) found = await market.ensureCover(id)
      if (!found) return sendCoverNotFound(res)
      const bytes = await readFileSafe(found.path)
      if (!bytes) return sendCoverNotFound(res)
      sendBinary(res, 200, 'image/png', bytes, 'private, max-age=604800')
    },
    'prefix',
  )

  /* ---- 9. 前端运行时静态文件 ---- */
  add('vendor/jsnes.js', async (url, req, res) => serveRuntimeScript(res, VENDOR_FILE, log))
  add('engine.js', async (url, req, res) => serveRuntimeScript(res, ENGINE_FILE, log))
  add('gamepads.js', async (url, req, res) => serveRuntimeScript(res, GAMEPADS_FILE, log))
  add('gamepad-settings.js', async (url, req, res) => serveRuntimeScript(res, GAMEPAD_SETTINGS_FILE, log))

  /* ---- 10. 强制同步 ---- */
  add('sync', async (url, req, res) => {
    requirePost(req)
    try {
      ok(res, await market.refreshAll())
    } catch (err) {
      fail(res, err, 'NETWORK')
    }
  })

  /* ---- 11. 设置（GET 读 / POST 写；token 只写不读不回显） ---- */
  add('settings', async (url, req, res) => {
    const method = str(req.method).toUpperCase() || 'GET'
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const patch = {}
      if (body.repo !== undefined) {
        const repo = str(body.repo).trim()
        if (!REPO_RE.test(repo)) {
          throw new GameBenchError('仓库格式应为 owner/name，例如 zeelinkCN/game-bench-library', 'BAD_REQUEST')
        }
        patch.repo = repo
      }
      if (body.token !== undefined) {
        if (typeof body.token !== 'string') throw new GameBenchError('token 必须是字符串', 'BAD_REQUEST')
        patch.token = body.token.trim()
      }
      const before = await store.readSettings()
      const repoBefore = store.repoOf(before)
      await store.writeSettings(patch)
      if (patch.repo !== undefined && patch.repo !== repoBefore) {
        await market.resetCache()
        log('资源库已切换，目录缓存已清空', patch.repo)
      }
      invalidateAuth()
    } else if (method !== 'GET' && method !== 'HEAD') {
      throw new GameBenchError('设置接口只支持 GET / POST', 'BAD_REQUEST')
    }

    const settings = await store.readSettings()
    const repo = store.repoOf(settings)
    const authInfo = await authWithBudget(repo)
    ok(res, {
      repo,
      hasToken: Boolean(settings.token),
      tokenSource: authInfo.kind,
      dataDir: dataDir(),
    })
  })

  return routes
}
