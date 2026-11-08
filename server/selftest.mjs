#!/usr/bin/env node
/**
 * 拾光游戏厅 Host 侧独立自测（不依赖 DSH 运行时）。
 *
 * 做法：
 *  1. 构造 fake ctx（webServer.register / effect / logger），调用 index.js 的 apply()
 *  2. 把注册到的路由按 Host 语义（exact / prefix）挂到本地 http.createServer 随机端口上
 *  3. 逐条断言 status / library / catalog / market / cover / rom / settings / install / uninstall，
 *     以及「无 token 时的 AUTH 错误态」「体积上限」「并发安装去重」等关键降级行为
 *
 * 真实网络可用（GitHub 私有资源库 + 本机 gh 登录）；GitHub 不可达时网络相关用例标 SKIP 而不是 FAIL。
 *
 * 用法：
 *   node server/selftest.mjs          # 用临时数据目录，跑完清理
 *   node server/selftest.mjs --keep   # 保留临时数据目录便于排查
 *
 * 退出码：0 全绿；1 存在 FAIL
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const ROUTE = '/game-bench/api'

/* ------------------------------------------------------------------ *
 * 测试框架
 * ------------------------------------------------------------------ */
let pass = 0
let fail = 0
let skipped = 0
const failures = []

const green = (text) => `\u001b[32m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`

const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`${green('PASS')} ${name}`)
    return true
  }
  fail += 1
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${red('FAIL')} ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

const skip = (name, reason) => {
  skipped += 1
  console.log(`${yellow('SKIP')} ${name} — ${reason}`)
}

const section = (title) => console.log(`\n── ${title} ──`)

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 请求结果是否代表「市场当前不可用」（无凭据 / 网络不通） */
const isUnavailable = (res) =>
  Boolean(res && res.json && res.json.ok === false && (res.json.code === 'NETWORK' || res.json.code === 'AUTH'))

/* ------------------------------------------------------------------ *
 * 准备临时数据目录（必须在 import 插件模块之前设置）
 * ------------------------------------------------------------------ */
const keepData = process.argv.includes('--keep')
const tempDir = await mkdtemp(join(tmpdir(), 'game-bench-selftest-'))
process.env.DSH_GAME_BENCH_DATA = tempDir

const { apply, inject } = await import('../index.js')
const { DEFAULT_REPO } = await import('./paths.mjs')
const { fetchRepoFile, resolveAuth } = await import('./github.mjs')

const { createBuiltin, mergeBuiltinManifests, PUBLIC_MANIFEST_FILE, LOCAL_MANIFEST_FILE } = await import('./builtin.mjs')
const builtinCatalog = createBuiltin({ log: () => {} })
const availableBuiltins = builtinCatalog.list()
const expectedBuiltinCount = availableBuiltins.length

/* ------------------------------------------------------------------ *
 * fake ctx + 本地 HTTP 服务
 * ------------------------------------------------------------------ */
const registeredRoutes = []
const pluginLogs = []
const fakeCtx = {
  webServer: {
    register(entry) {
      registeredRoutes.push(entry)
      return () => {
        const index = registeredRoutes.indexOf(entry)
        if (index >= 0) registeredRoutes.splice(index, 1)
      }
    },
  },
  effect(fn) {
    return fn()
  },
  logger: {
    info() {},
    warn() {},
    error: (...args) => pluginLogs.push(args.map(String).join(' ')),
  },
  get() {
    return undefined
  },
}

apply(fakeCtx)

const matchRoute = (pathname) => {
  const exact = registeredRoutes.find((entry) => entry.kind !== 'prefix' && entry.path === pathname)
  if (exact) return exact
  return (
    registeredRoutes.find(
      (entry) => entry.kind === 'prefix' && (pathname === entry.path || pathname.startsWith(`${entry.path}/`)),
    ) || null
  )
}

const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    url = new URL('/', 'http://127.0.0.1')
  }
  const entry = matchRoute(url.pathname)
  if (!entry) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: '没有匹配的路由', code: 'NOT_FOUND' }))
    return
  }
  Promise.resolve(entry.handler(req, res)).catch((err) => {
    if (res.writableEnded) return
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err), code: 'INTERNAL' }))
  })
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const origin = `http://127.0.0.1:${server.address().port}`

const call = async (path, options = {}) => {
  const { method = 'GET', body, timeout = 60000 } = options
  const response = await fetch(origin + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const contentType = response.headers.get('content-type') || ''
  const buffer = Buffer.from(await response.arrayBuffer())
  let json = null
  if (contentType.includes('application/json')) {
    try {
      json = JSON.parse(buffer.toString('utf8'))
    } catch {
      json = null
    }
  }
  return { status: response.status, headers: response.headers, buffer, json, contentType }
}

const api = (path) => `${ROUTE}${path}`

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
try {
  console.log(`拾光游戏厅 Host 自测 · 数据目录 ${tempDir}`)

  section('路由装配')
  check('导出 apply() 与 inject [webServer]', typeof apply === 'function' && Array.isArray(inject) && inject.includes('webServer'))
  check('注册路由数量 >= 12', registeredRoutes.length >= 12, `实际 ${registeredRoutes.length}`)
  check(
    '关键路由已注册',
    ['status', 'library', 'catalog', 'market', 'install', 'uninstall', 'sync', 'settings', 'rom', 'cover'].every((name) =>
      registeredRoutes.some((entry) => entry.path === `${ROUTE}/${name}`),
    ),
  )

  section('激活降级（webServer.register 抛异常时 apply 不炸）')
  let applySurvived = true
  try {
    apply({
      webServer: {
        register() {
          throw new Error('duplicate route')
        },
      },
      effect(fn) {
        return fn()
      },
      logger: {},
      get() {
        return undefined
      },
    })
  } catch {
    applySurvived = false
  }
  check('全部路由注册失败时 apply 也不抛异常', applySurvived)
  check('原有路由仍然可用', matchRoute(`${ROUTE}/status`) !== null)

  section('GET /status')
  const statusRes = await call(api('/status'))
  const statusData = statusRes.json?.data || {}
  check('HTTP 200 且信封 ok', statusRes.status === 200 && statusRes.json?.ok === true, JSON.stringify(statusRes.json).slice(0, 160))
  check(
    '内置数量与可用清单一致',
    statusData.builtinCount === expectedBuiltinCount && expectedBuiltinCount >= 1,
    `实际 ${statusData.builtinCount} / 期望 ${expectedBuiltinCount}`,
  )
  check('installedCount 为数字', Number.isInteger(statusData.installedCount))
  check('dataDir 指向临时目录', statusData.dataDir === tempDir, `实际 ${statusData.dataDir}`)
  check(
    'market.auth 合法',
    ['settings', 'env', 'gh', 'public', 'none'].includes(statusData.market?.auth),
    `实际 ${statusData.market?.auth}`,
  )
  check('market 结构完整', typeof statusData.market?.ready === 'boolean' && typeof statusData.market?.repo === 'string')
  check('vendor 结构完整', typeof statusData.vendor?.jsnes === 'boolean' && typeof statusData.vendor?.engine === 'boolean')
  check('响应头 Cache-Control: no-store', statusRes.headers.get('cache-control') === 'no-store')
  console.log(
    `   auth=${statusData.market?.auth} repo=${statusData.market?.repo} catalogGames=${statusData.market?.catalogGames} vendor=${JSON.stringify(statusData.vendor)}`,
  )

  section('GET /library')
  const libraryRes = await call(api('/library'))
  const libraryData = libraryRes.json?.data || {}
  check('HTTP 200 且信封 ok', libraryRes.status === 200 && libraryRes.json?.ok === true)
  check('builtinCount 与可用清单一致', libraryData.builtinCount === expectedBuiltinCount, `实际 ${libraryData.builtinCount} / 期望 ${expectedBuiltinCount}`)
  check('games 至少等于内置数量', Array.isArray(libraryData.games) && libraryData.games.length >= expectedBuiltinCount)
  const builtinRanks = (libraryData.games || []).slice(0, expectedBuiltinCount).map((game) => game.featuredRank)
  const rankWeight = (rank) => (rank > 0 ? rank : Number.MAX_SAFE_INTEGER)
  check(
    '内置按 featuredRank 升序（0 排名排最后）',
    builtinRanks.every((rank, index) => index === 0 || rankWeight(builtinRanks[index - 1]) <= rankWeight(rank)),
    JSON.stringify(builtinRanks),
  )
  check(
    '内置游戏 builtin/installed 均为 true',
    (libraryData.games || []).slice(0, expectedBuiltinCount).every((game) => game.builtin === true && game.installed === true),
  )
  const firstBuiltin = libraryData.games?.[0]
  check('rom/cover 是接口 URL', String(firstBuiltin?.rom || '').startsWith(`${ROUTE}/rom/`) && String(firstBuiltin?.cover || '').startsWith(`${ROUTE}/cover/`))
  check('sha256/size 字段存在', typeof firstBuiltin?.sha256 === 'string' && typeof firstBuiltin?.size === 'number')

  section('内置 ROM / 封面（二进制路由）')
  const builtinFirst = (libraryData.games || []).find((game) => game.builtin === true) || null
  if (!builtinFirst) {
    skip('内置 ROM 与封面', '没有可用的内置游戏')
  } else {
    const romRes = await call(api(`/rom/${builtinFirst.id}`))
    check('内置 ROM 200', romRes.status === 200, `status=${romRes.status}`)
    check('内置 ROM 字节 SHA-256 与清单一致', sha256(romRes.buffer) === builtinFirst.sha256)
    check('ROM Content-Type = application/octet-stream', (romRes.headers.get('content-type') || '').includes('application/octet-stream'))
    check('内置 ROM 允许私有缓存', romRes.headers.get('cache-control') === 'private, max-age=86400')

    const coverRes = await call(api(`/cover/${builtinFirst.id}`))
    check('内置封面 200', coverRes.status === 200)
    check('内置封面 Content-Type = image/png', (coverRes.headers.get('content-type') || '').includes('image/png'))
    check('内置封面是 PNG 字节（89 50 4E 47）', coverRes.buffer.subarray(0, 4).toString('hex') === '89504e47')
    check('内置封面非空', coverRes.buffer.length > 100)
    check('封面缓存头 private, max-age=604800', coverRes.headers.get('cache-control') === 'private, max-age=604800')
  }

  section('自制 demo（非 nes-<sha256> 的内置 id）')
  const demoBuiltin = (libraryData.games || []).find((game) => game.builtin === true && !game.id.startsWith('nes-')) || null
  if (!demoBuiltin) {
    skip('自制 demo 的 ROM/封面路由', '公开清单里没有非 nes- 前缀的内置游戏')
  } else {
    const demoRom = await call(api(`/rom/${encodeURIComponent(demoBuiltin.id)}`))
    check('demo /rom/<id> 200', demoRom.status === 200, `status=${demoRom.status}`)
    check('demo ROM SHA-256 与清单一致', sha256(demoRom.buffer) === demoBuiltin.sha256)
    const demoCover = await call(api(`/cover/${encodeURIComponent(demoBuiltin.id)}`))
    check('demo /cover/<id> 200 image/png', demoCover.status === 200 && demoCover.buffer.subarray(0, 4).toString('hex') === '89504e47')
    console.log(`   demo id=${demoBuiltin.id} title=${demoBuiltin.title}`)
  }

  section('内置清单合并（builtin.json + builtin.local.json）')
  let publicDoc = null
  try {
    publicDoc = JSON.parse(readFileSync(PUBLIC_MANIFEST_FILE, 'utf8'))
  } catch {
    publicDoc = null
  }
  const publicGames = Array.isArray(publicDoc) ? publicDoc : Array.isArray(publicDoc?.games) ? publicDoc.games : []
  const samplePublic = publicGames.find((game) => game && typeof game === 'object' && game.id)
  if (!samplePublic) {
    skip('内置清单合并', '公开清单 games/builtin.json 为空或不存在')
  } else {
    const localOverride = { version: 1, games: [{ ...samplePublic, title: '本地覆盖标题' }] }
    const merged = mergeBuiltinManifests(publicDoc, localOverride)
    check(
      'local 清单同 id 覆盖 public 标题',
      merged.some((game) => game.id === samplePublic.id && game.title === '本地覆盖标题'),
    )
    check('合并结果无重复 id', merged.length === new Set(merged.map((game) => game.id)).size)
    const phantomId = `nes-${'a'.repeat(64)}`
    const phantom = mergeBuiltinManifests(
      { version: 1, games: [{ ...samplePublic, id: phantomId, file: `${phantomId}.nes`, sha256: phantomId.slice(4) }] },
      null,
    )
    check('ROM 文件缺失的条目被跳过（不报错）', phantom.length === 0)
    check('真实可用条目数与 builtin 模块一致', merged.length <= expectedBuiltinCount + 1)
  }

  section('未知 / 非法 id 的降级')
  const emptyId = `nes-${'0'.repeat(64)}`
  const badRom = await call(api(`/rom/${emptyId}`))
  check('未知 ROM 404 + JSON 信封', badRom.status === 404 && badRom.json?.code === 'NOT_FOUND', `status=${badRom.status}`)
  const badCover = await call(api(`/cover/${emptyId}`))
  check('未知封面 404 且无响应体', badCover.status === 404 && badCover.buffer.length === 0)
  const traversal = await call(api('/rom/..%2F..%2Fsettings.json'))
  check('路径穿越 id 被拒（404）', traversal.status === 404 && traversal.json?.ok === false)

  section('静态运行时 /vendor/jsnes.js、/engine.js')
  for (const [name, file] of [
    ['vendor/jsnes.js', join(PLUGIN_ROOT, 'vendor', 'jsnes.min.js')],
    ['engine.js', join(PLUGIN_ROOT, 'engine.js')],
  ]) {
    const res = await call(api(`/${name}`))
    if (!existsSync(file)) {
      skip(`GET ${api(`/${name}`)}`, '队友尚未放入该文件（返回 404 属预期降级）')
      continue
    }
    check(`GET ${api(`/${name}`)} 200`, res.status === 200)
    check(`${name} Content-Type 为 JS`, (res.headers.get('content-type') || '').includes('javascript'))
    check(`${name} 返回非空内容`, res.buffer.length > 0)
  }

  section('GET /settings')
  const settingsRes = await call(api('/settings'))
  const settingsData = settingsRes.json?.data || {}
  check('HTTP 200 且信封 ok', settingsRes.status === 200 && settingsRes.json?.ok === true)
  check('repo 为 owner/name', /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(settingsData.repo || ''), `实际 ${settingsData.repo}`)
  check('hasToken 为布尔', typeof settingsData.hasToken === 'boolean')
  check('tokenSource 合法', ['settings', 'env', 'gh', 'public', 'none'].includes(settingsData.tokenSource), `实际 ${settingsData.tokenSource}`)
  check('dataDir 正确', settingsData.dataDir === tempDir)
  check('响应体不含 token 字段', !Object.hasOwn(settingsData, 'token') && !JSON.stringify(settingsData).includes('"token"'))

  section('鉴权解析（settings -> env -> gh -> public -> none）')
  let authInfo = null
  try {
    authInfo = await resolveAuth({ repo: DEFAULT_REPO, log: () => {} })
  } catch (err) {
    authInfo = null
  }
  check(
    '鉴权结果 kind 合法',
    Boolean(authInfo) && ['settings', 'env', 'gh', 'public', 'none'].includes(authInfo.kind),
    JSON.stringify(authInfo?.kind),
  )
  console.log(`   当前鉴权方式：${authInfo?.kind}`)

  // 假 token -> GitHub 401 -> AUTH
  let fakeCode = ''
  try {
    await fetchRepoFile({
      repo: DEFAULT_REPO,
      path: 'store.json',
      auth: { kind: 'settings', token: `ghp_${'x'.repeat(36)}` },
      timeoutMs: 20000,
      maxBytes: 2 * 1024 * 1024,
      kind: 'catalog',
    })
  } catch (err) {
    fakeCode = err?.code || ''
  }
  if (fakeCode === 'AUTH') check('假 token 归为 AUTH（不是静默失败）', true)
  else if (fakeCode === 'NETWORK') skip('假 token 归为 AUTH', 'GitHub 不可达 / 被限流')
  else check('假 token 归为 AUTH（不是静默失败）', false, `code=${fakeCode || '无错误'}`)

  // 完全不带 token 的匿名访问：私有仓库应 404 -> AUTH；公开仓库应能匿名读到字节
  let anonymous = { ok: false, code: '' }
  try {
    const bytes = await fetchRepoFile({
      repo: DEFAULT_REPO,
      path: 'store.json',
      auth: { kind: 'public', token: '' },
      timeoutMs: 20000,
      maxBytes: 2 * 1024 * 1024,
      kind: 'catalog',
    })
    anonymous = { ok: true, code: '', bytes: bytes.length }
  } catch (err) {
    anonymous = { ok: false, code: err?.code || '' }
  }
  if (anonymous.ok) {
    check('匿名（无 token）可读公开资源库（public 模式可用）', anonymous.bytes > 100)
    skip('匿名访问私有仓库归为 AUTH', '资源库当前是公开仓库，该用例仅在私有仓库下适用')
  } else if (anonymous.code === 'AUTH') {
    check('匿名访问私有仓库（404）归为 AUTH', true)
    skip('匿名可读公开资源库', '资源库当前为私有仓库')
  } else if (anonymous.code === 'NETWORK') {
    skip('匿名访问私有仓库归为 AUTH', 'raw.githubusercontent.com 不可达')
  } else {
    check('匿名访问归一化', false, `code=${anonymous.code || '无错误'}`)
  }

  section('gh CLI 兜底传输（https 被网络卡住时的备用链路）')
  try {
    const { ghApiFetch } = await import('./github.mjs')
    const bytes = await ghApiFetch({
      repo: DEFAULT_REPO,
      path: 'store.json',
      kind: 'catalog',
      timeoutMs: 20000,
      maxBytes: 2 * 1024 * 1024,
    })
    const doc = JSON.parse(bytes.toString('utf8'))
    check(
      'gh api 兜底取到 store.json 且字节正确',
      bytes.length > 1000 && Array.isArray(doc.collections) && doc.collections.length === 7,
      `bytes=${bytes.length} collections=${doc.collections?.length}`,
    )
  } catch (err) {
    if (err?.code === 'NETWORK' || err?.code === 'AUTH' || err?.code === 'NOT_FOUND') {
      skip('gh api 兜底传输', `gh 不可用/未登录：${String(err?.message || '').slice(0, 60)}`)
    } else {
      check('gh api 兜底传输', false, String(err?.message || err))
    }
  }

  let marketOk = false

  section('GET /catalog?q=魂斗罗')
  const catalogRes = await call(api(`/catalog?q=${encodeURIComponent('魂斗罗')}&limit=120`))
  if (isUnavailable(catalogRes)) {
    skip('市场目录（/catalog、/market、安装流程）', `市场不可用：${catalogRes.json?.code} ${catalogRes.json?.error}`)
  } else {
    const catalogData = catalogRes.json?.data || {}
    check('HTTP 200 且信封 ok', catalogRes.status === 200 && catalogRes.json?.ok === true, JSON.stringify(catalogRes.json).slice(0, 160))
    check('搜索命中 >= 1', catalogData.total >= 1, `total=${catalogData.total}`)
    check(
      '结果均匹配关键词（title/sourceNames）',
      (catalogData.items || []).every(
        (item) => item.title.includes('魂斗罗') || (item.sourceNames || []).some((name) => name.includes('魂斗罗')),
      ),
    )
    check('分页字段完整', typeof catalogData.offset === 'number' && typeof catalogData.limit === 'number')
    const capRes = await call(api('/catalog?limit=999'))
    check('limit 上限 120', capRes.json?.data?.limit === 120, `实际 ${capRes.json?.data?.limit}`)

    section('GET /market')
    const marketRes = await call(api('/market'))
    const marketData = marketRes.json?.data || {}
    check('HTTP 200 且信封 ok', marketRes.status === 200 && marketRes.json?.ok === true)
    check('合集数量 = 7', (marketData.collections || []).length === 7, `实际 ${(marketData.collections || []).length}`)
    check('featured 12 款', (marketData.featured || []).length === 12, `实际 ${(marketData.featured || []).length}`)
    check(
      '每个合集最多 8 款且字段完整',
      (marketData.collections || []).every(
        (collection) => (collection.games || []).length <= 8 && typeof collection.id === 'string' && typeof collection.title === 'string',
      ),
    )
    check('market.title 来自 store.json', typeof marketData.title === 'string' && marketData.title.length > 0)
    check('auth 合法', ['settings', 'env', 'gh', 'public', 'none'].includes(marketData.auth))
    console.log(`   total=${marketData.total} collections=${marketData.collections?.length} featured=${marketData.featured?.length}`)
    marketOk = true

    section('GET /catalog?collection=childhood（合集顺序）')
    const collectionRes = await call(api('/catalog?collection=childhood&limit=10'))
    const collectionData = collectionRes.json?.data || {}
    check('合集过滤 total = 40', collectionData.total === 40, `实际 ${collectionData.total}`)
    check(
      '合集保持 store.json 内顺序（首款为超级玛丽1）',
      collectionData.items?.[0]?.id === (libraryData.games || [])[0]?.id,
      `实际 ${collectionData.items?.[0]?.title}`,
    )

    section('POST /sync 强制刷新 + /status 就绪态')
    const syncRes = await call(api('/sync'), { method: 'POST', body: {} })
    const syncData = syncRes.json?.data || {}
    check('POST /sync 成功', syncRes.status === 200 && syncRes.json?.ok === true, JSON.stringify(syncRes.json).slice(0, 160))
    check('/sync total = 1131', syncData.total === 1131, `实际 ${syncData.total}`)
    check('/sync collections = 7', syncData.collections === 7, `实际 ${syncData.collections}`)
    check('/sync lastSync 为时间戳', typeof syncData.lastSync === 'number' && syncData.lastSync > 0)
    check('/sync auth 合法', ['settings', 'env', 'gh', 'public', 'none'].includes(syncData.auth))
    const statusReady = await call(api('/status'))
    check(
      '/status ready=true 且 catalogGames=1131',
      statusReady.json?.data?.market?.ready === true && statusReady.json?.data?.market?.catalogGames === 1131,
      `ready=${statusReady.json?.data?.market?.ready} catalogGames=${statusReady.json?.data?.market?.catalogGames}`,
    )
    check('/status lastSync 已填充', typeof statusReady.json?.data?.market?.lastSync === 'number')
    check('目录缓存已落盘 catalog.json', existsSync(join(tempDir, 'catalog.json')))
    check('市场配置已落盘 store.json', existsSync(join(tempDir, 'store.json')))

    section('GET /library（合集标签，联网后）')
    const libraryAgain = await call(api('/library'))
    const firstBuiltinAgain = (libraryAgain.json?.data?.games || [])[0]
    check('内置游戏 tags 来自市场合集', Array.isArray(firstBuiltinAgain?.tags) && firstBuiltinAgain.tags.includes('童年经典'), JSON.stringify(firstBuiltinAgain?.tags))

    section('封面懒加载（未安装的市场游戏）')
    const lazyTarget =
      (marketData.featured || []).find((item) => !item.builtin && !item.installed) ||
      (marketData.featured || []).find((item) => !item.builtin)
    if (!lazyTarget) {
      skip('封面懒加载', 'featured 里没有未安装的市场游戏')
    } else {
      const lazyCoverFile = join(tempDir, 'covers', `${lazyTarget.id}.png`)
      const lazyCover = await call(api(`/cover/${lazyTarget.id}`))
      if (lazyCover.status === 200) {
        check('未安装游戏封面懒加载 200', true)
        check('懒加载封面已落盘 <dataDir>/covers/', existsSync(lazyCoverFile))
        check('懒加载封面 Content-Type = image/png', (lazyCover.headers.get('content-type') || '').includes('image/png'))
        const lazyAgain = await call(api(`/cover/${lazyTarget.id}`))
        check('二次请求命中本地缓存（字节一致）', lazyAgain.status === 200 && lazyAgain.buffer.equals(lazyCover.buffer))
      } else {
        skip('未安装游戏封面懒加载', `status=${lazyCover.status}（封面拉取失败按契约返回 404）`)
      }
      const lazyRom = await call(api(`/rom/${lazyTarget.id}`))
      check('未安装市场游戏 /rom 返回 404（不懒加载 ROM）', lazyRom.status === 404 && lazyRom.json?.code === 'NOT_FOUND')
    }
  }

  section('安装 / 幂等 / 并发去重 / 卸载')
  if (!marketOk) {
    skip('安装流程', '市场不可用')
  } else {
    const targetRes = await call(api(`/catalog?q=${encodeURIComponent('俄罗斯方块')}&limit=20`))
    const candidates = targetRes.json?.data?.items || []
    const target = candidates.find((item) => !item.builtin) || candidates[0]
    if (!target) {
      skip('安装流程', '目录里找不到「俄罗斯方块」')
    } else {
      const installRes = await call(api('/install'), { method: 'POST', body: { id: target.id } })
      if (isUnavailable(installRes)) {
        skip('安装流程', `安装接口不可用：${installRes.json?.code} ${installRes.json?.error}`)
      } else {
        const installData = installRes.json?.data || {}
        check('POST /install 成功', installRes.status === 200 && installRes.json?.ok === true, JSON.stringify(installRes.json).slice(0, 200))
        check('返回 bytes > 0', Number(installData.bytes) > 0, `bytes=${installData.bytes}`)
        check('返回 game.installed = true', installData.game?.installed === true)
        check('返回 cover 为布尔', typeof installData.cover === 'boolean')
        check('首次安装 alreadyInstalled = false', installData.alreadyInstalled === false)

        const romFile = join(tempDir, 'roms', `${target.id}.nes`)
        check('ROM 已落盘 <dataDir>/roms/<id>.nes', existsSync(romFile))
        check(
          '落盘 ROM SHA-256 与目录一致',
          existsSync(romFile) && sha256(readFileSync(romFile)) === target.sha256,
          `期望 ${String(target.sha256).slice(0, 12)}`,
        )
        const romDownloaded = await call(api(`/rom/${target.id}`))
        check('GET /rom/<id> 200 且 SHA-256 一致', romDownloaded.status === 200 && sha256(romDownloaded.buffer) === target.sha256)
        check('已下载 ROM Cache-Control = no-store', romDownloaded.headers.get('cache-control') === 'no-store')
        const coverDownloaded = await call(api(`/cover/${target.id}`))
        if (installData.cover) {
          check('GET /cover/<id> 200 image/png', coverDownloaded.status === 200 && (coverDownloaded.headers.get('content-type') || '').includes('image/png'))
        } else {
          skip('GET /cover/<id>', '本次安装封面下载失败（安装已降级成功）')
        }

        const libInstalled = await call(api('/library'))
        const libInstalledData = libInstalled.json?.data || {}
        check('安装后 installedCount = 1', libInstalledData.installedCount === 1, `实际 ${libInstalledData.installedCount}`)
        check(
          'library 含已装游戏（builtin:false, installed:true）',
          (libInstalledData.games || []).some((game) => game.id === target.id && game.builtin === false && game.installed === true),
        )
        check('library 中已装游戏带 tags 字段', Array.isArray((libInstalledData.games || []).find((game) => game.id === target.id)?.tags))
        const libraryFile = join(tempDir, 'library.json')
        check('library.json 已落盘', existsSync(libraryFile))
        if (existsSync(libraryFile)) {
          const libraryDoc = JSON.parse(readFileSync(libraryFile, 'utf8'))
          check(
            'library.json 结构正确（version + games<id,installedAt,sha256>）',
            libraryDoc?.version === 1 &&
              Array.isArray(libraryDoc?.games) &&
              libraryDoc.games.some(
                (game) => game.id === target.id && typeof game.installedAt === 'number' && typeof game.sha256 === 'string',
              ),
          )
        }

        const againRes = await call(api('/install'), { method: 'POST', body: { id: target.id } })
        check('重复安装幂等（alreadyInstalled = true）', againRes.json?.ok === true && againRes.json?.data?.alreadyInstalled === true)

        // 并发安装去重：先卸载，再同时发两个安装请求，两者都必须成功且不产生重复记录
        const uninstallBeforeConcurrent = await call(api('/uninstall'), { method: 'POST', body: { id: target.id } })
        check('卸载成功（removed = true）', uninstallBeforeConcurrent.json?.data?.removed === true, JSON.stringify(uninstallBeforeConcurrent.json).slice(0, 160))
        check('卸载已删除 ROM 文件', !existsSync(romFile))
        check('卸载后 installedCount = 0', (await call(api('/library'))).json?.data?.installedCount === 0)

        const [concurrentA, concurrentB] = await Promise.all([
          call(api('/install'), { method: 'POST', body: { id: target.id } }),
          call(api('/install'), { method: 'POST', body: { id: target.id } }),
        ])
        check('并发安装两个请求都成功', concurrentA.json?.ok === true && concurrentB.json?.ok === true)
        const libAfterConcurrent = await call(api('/library'))
        check(
          '并发安装不产生重复记录',
          (libAfterConcurrent.json?.data?.games || []).filter((game) => game.id === target.id).length === 1,
        )

        const uninstallRes = await call(api('/uninstall'), { method: 'POST', body: { id: target.id } })
        check('卸载成功且 removed = true', uninstallRes.json?.ok === true && uninstallRes.json?.data?.removed === true)
        check('卸载后 ROM 文件已删除', !existsSync(romFile))
        check('卸载后封面文件已删除', !existsSync(join(tempDir, 'covers', `${target.id}.png`)))
        check('卸载后 installedCount = 0', (await call(api('/library'))).json?.data?.installedCount === 0)

        if (builtinFirst) {
          const builtinUninstall = await call(api('/uninstall'), { method: 'POST', body: { id: builtinFirst.id } })
          check('卸载内置游戏为 no-op（removed = false、不报错）', builtinUninstall.status === 200 && builtinUninstall.json?.data?.removed === false)
        }
      }
    }
  }

  section('体积上限（ROM 8MB / 封面 2MB / 目录 20MB）')
  if (!marketOk) {
    skip('超出 maxBytes 时拒绝下载', '市场不可用')
  } else {
    let capCode = ''
    let currentAuth = null
    try {
      currentAuth = await resolveAuth({ repo: DEFAULT_REPO, log: () => {} })
    } catch {
      currentAuth = null
    }
    try {
      await fetchRepoFile({
        repo: DEFAULT_REPO,
        path: 'store.json',
        auth: currentAuth,
        timeoutMs: 20000,
        maxBytes: 64,
        kind: 'catalog',
      })
    } catch (err) {
      capCode = err?.code || ''
    }
    if (capCode === 'UNSUPPORTED') check('超出 maxBytes 被拒绝（UNSUPPORTED）', true)
    else if (capCode === 'NETWORK' || capCode === 'AUTH') skip('超出 maxBytes 被拒绝', '市场不可用')
    else check('超出 maxBytes 被拒绝（UNSUPPORTED）', false, `code=${capCode || '无错误'}`)
  }

  section('请求参数校验（本地用例）')
  const syncGet = await call(api('/sync'))
  check('/sync 只接受 POST（GET -> 400）', syncGet.status === 400 && syncGet.json?.code === 'BAD_REQUEST', `status=${syncGet.status}`)
  const installGet = await call(api('/install'))
  check('/install 只接受 POST（GET -> 400）', installGet.status === 400 && installGet.json?.code === 'BAD_REQUEST')
  const badId = await call(api('/install'), { method: 'POST', body: { id: 'not-a-nes-id' } })
  check('/install 非法 id -> 400 BAD_REQUEST', badId.status === 400 && badId.json?.code === 'BAD_REQUEST')
  const badRepo = await call(api('/settings'), { method: 'POST', body: { repo: 'no-slash-repo' } })
  check('/settings 非法 repo -> 400 BAD_REQUEST', badRepo.status === 400 && badRepo.json?.code === 'BAD_REQUEST')

  section('AUTH 错误态（切到无权限仓库）')
  const bogusRepo = 'nonexistent-owner-xyz/game-bench-selftest-no-such-repo'
  const switchRes = await call(api('/settings'), { method: 'POST', body: { repo: bogusRepo } })
  check('切换到无权限仓库成功', switchRes.status === 200 && switchRes.json?.data?.repo === bogusRepo)
  const authState = await call(api('/catalog?q=x'))
  if (authState.json?.code === 'AUTH') {
    check('市场不可用时返回 AUTH + 中文引导', authState.status === 401 && typeof authState.json?.error === 'string' && authState.json.error.includes('GitHub'))
  } else if (authState.json?.code === 'NETWORK') {
    skip('市场不可用时返回 AUTH', 'GitHub 不可达（返回 NETWORK）')
  } else {
    check('市场不可用时返回 AUTH + 中文引导', false, `status=${authState.status} code=${authState.json?.code}`)
  }
  const restoreRes = await call(api('/settings'), { method: 'POST', body: { repo: DEFAULT_REPO } })
  check('恢复默认仓库', restoreRes.status === 200 && restoreRes.json?.data?.repo === DEFAULT_REPO)

  section('settings 写入 / Token 只写不读 / 文件权限')
  const tokenValue = 'ghp_selftest_fake_token_value_1234567890'
  const writeToken = await call(api('/settings'), { method: 'POST', body: { token: tokenValue } })
  check('POST /settings 写入 token 成功', writeToken.status === 200)
  const readAfterToken = await call(api('/settings'))
  const readAfterTokenData = readAfterToken.json?.data || {}
  check('tokenSource 变为 settings', readAfterTokenData.tokenSource === 'settings', `实际 ${readAfterTokenData.tokenSource}`)
  check('hasToken = true', readAfterTokenData.hasToken === true)
  check('GET /settings 不回显 token', !JSON.stringify(readAfterTokenData).includes('selftest_fake'))
  const settingsFile = join(tempDir, 'settings.json')
  check('settings.json 已落盘', existsSync(settingsFile))
  if (existsSync(settingsFile)) {
    const mode = statSync(settingsFile).mode & 0o777
    check('settings.json 权限 0600', mode === 0o600, `mode=${mode.toString(8)}`)
  }
  const clearToken = await call(api('/settings'), { method: 'POST', body: { token: '' } })
  check('传空 token 清除已保存 token', clearToken.status === 200 && clearToken.json?.data?.hasToken === false)

  section('鉴权优先级（env 覆盖 gh）')
  const previousEnvToken = process.env.GITHUB_TOKEN
  const previousGhTokenEnv = process.env.GH_TOKEN
  process.env.GITHUB_TOKEN = 'ghp_selftest_env_token_1234567890'
  const envAuth = await resolveAuth({ repo: DEFAULT_REPO, log: () => {}, force: true })
  check('GITHUB_TOKEN/GH_TOKEN 优先于 gh 自动登录', envAuth?.kind === 'env', `实际 ${envAuth?.kind}`)
  if (previousEnvToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = previousEnvToken
  if (previousGhTokenEnv === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = previousGhTokenEnv
  await resolveAuth({ repo: DEFAULT_REPO, log: () => {}, force: true }).catch(() => {})

  section('收尾健康检查')
  const finalStatus = await call(api('/status'))
  check('最终 /status 仍为 200', finalStatus.status === 200 && finalStatus.json?.ok === true)
  check(
    '最终 /status 内置数量仍与清单一致',
    finalStatus.json?.data?.builtinCount === expectedBuiltinCount && expectedBuiltinCount >= 1,
    `实际 ${finalStatus.json?.data?.builtinCount}`,
  )
} catch (err) {
  fail += 1
  failures.push(`自测脚本异常：${err?.stack || err}`)
  console.error(red(`\n自测脚本异常：${err?.stack || err}`))
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  if (!keepData) await rm(tempDir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(52)}`)
console.log(`结果：${green(`PASS ${pass}`)}  ${fail ? red(`FAIL ${fail}`) : `FAIL 0`}  ${yellow(`SKIP ${skipped}`)}`)
if (failures.length) {
  console.log('失败用例：')
  for (const item of failures) console.log(`  - ${item}`)
}
if (keepData) console.log(`数据目录已保留：${tempDir}`)
process.exitCode = fail ? 1 : 0
