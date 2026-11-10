/**
 * 在线游戏市场：资源库目录缓存、目录查询、安装/卸载、封面懒加载。
 *
 * 职责：
 *  - catalog.json / store.json 首次拉取原子落盘，TTL 24h；POST /sync 强制刷新
 *  - 刷新失败保留旧缓存（本地文件不被破坏），只在「完全没缓存」时才向上报错
 *  - /catalog、/market 的数据组装；/install 下载 ROM + 封面、SHA-256 校验、原子写
 *  - 同一 id 并发安装去重（共享同一个 Promise）；封面懒加载全局并发上限 4 + in-flight 去重 + 失败缓存 5 分钟
 *
 * 上游：GitHub 资源库 zeelinkCN/game-bench-library（catalog.json / store.json / owned/*.nes / covers/*.png）
 * 降级：
 *  - 上游失败：有旧缓存就继续用旧缓存并记录 lastError；无缓存才抛 AUTH/NETWORK
 *  - 封面下载失败不影响安装（/install 返回 cover:false），/cover 最终 404 让前端画占位色块
 */
import { GameBenchError, ERROR_TEXT } from './errors.mjs'
import {
  ensureDir,
  fileExists,
  readJsonFile,
  removeSafe,
  sha256Hex,
  statSafe,
  writeFileAtomic,
} from './fsutil.mjs'
import { cleanRelPath, fetchRepoFile, peekAuth, resolveAuth } from './github.mjs'
import {
  ID_RE,
  ROUTE,
  catalogFile,
  coverDir,
  coverPath,
  dataDir,
  romDir,
  romPath,
  storeFile,
} from './paths.mjs'

/** 目录缓存 TTL：24 小时 */
const CACHE_TTL = 24 * 60 * 60 * 1000
/** 缓存过期后再次尝试刷新的最小间隔（离线时避免每次请求都打 GitHub） */
const RETRY_COOLDOWN = 2 * 60 * 1000
/** 单次下载超时 / 体积上限（契约：ROM 8MB、封面 2MB、单款 30s；首次冷启动目录给 45s） */
const CATALOG_TIMEOUT = 45_000
const DOWNLOAD_TIMEOUT = 30_000
const CATALOG_MAX_BYTES = 20 * 1024 * 1024
const STORE_MAX_BYTES = 2 * 1024 * 1024
const ROM_MAX_BYTES = 8 * 1024 * 1024
const COVER_MAX_BYTES = 2 * 1024 * 1024
/** 封面懒加载并发上限与失败缓存 */
const COVER_CONCURRENCY = 4
const COVER_FAIL_TTL = 5 * 60 * 1000

const MARKET_TITLE = '拾光游戏市场'

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const isSha = (value) => /^[0-9a-f]{64}$/.test(str(value))

const shaOf = (game) => (isSha(game?.sha256) ? str(game.sha256) : String(game?.id || '').slice(4))

/** 解析 catalog 内容（数组，或 { games: [] }） */
function catalogGamesOf(doc) {
  if (Array.isArray(doc)) return doc
  if (doc && Array.isArray(doc.games)) return doc.games
  return null
}

/** 把任意异常归一化为 GameBenchError；没 token 时的网络失败引导到 AUTH */
function normalizeError(err) {
  if (err instanceof GameBenchError) {
    const cached = peekAuth()
    if (cached && cached.kind === 'none' && err.code === 'NETWORK') {
      return new GameBenchError(ERROR_TEXT.AUTH, 'AUTH', { cause: err })
    }
    return err
  }
  const detail = String(err?.message ?? err).slice(0, 160)
  return new GameBenchError(`出现意外错误：${detail}`, 'INTERNAL', { cause: err })
}

/**
 * @param {{
 *   log?: (...args: any[]) => void,
 *   store: ReturnType<import('./store.mjs').createStore>,
 *   builtin: ReturnType<import('./builtin.mjs').createBuiltin>,
 * }} options
 */
export function createMarket({ log = () => {}, store, builtin }) {
  /** @type {{ catalog: { at: number, games: any[] } | null, storeDoc: { at: number, doc: any } | null }} */
  const state = {
    catalog: null,
    storeDoc: null,
    lastError: '',
    lastAttempt: 0,
  }
  /** 进行中的目录/市场刷新（避免重复请求） */
  const inflight = new Map()
  /** 进行中的安装（同一 id 共享同一个 Promise） */
  const installs = new Map()
  /** 封面懒加载 in-flight */
  const coverPromises = new Map()
  /** 封面失败缓存 id -> 时间戳（5 分钟内不再打 GitHub） */
  const coverFails = new Map()
  /** 封面下载并发控制 */
  const coverSlots = { active: 0, waiters: [] }

  const setLastError = (message) => {
    state.lastError = String(message || '')
  }

  const dedupe = (key, task) => {
    const running = inflight.get(key)
    if (running) return running
    const promise = Promise.resolve()
      .then(task)
      .finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  const repo = async () => store.repoOf(await store.readSettings())

  const authFor = async (repoName, force = false) => resolveAuth({ repo: repoName, log, force })

  /* ---------------------------------------------------------------- *
   * 磁盘缓存读取（不联网）
   * ---------------------------------------------------------------- */

  async function loadCatalogFromDisk() {
    const file = catalogFile()
    const stat = await statSafe(file)
    if (!stat || !stat.isFile()) return null
    const doc = await readJsonFile(file, null, log)
    const games = catalogGamesOf(doc)
    if (!games) return null
    return { at: stat.mtimeMs, games }
  }

  async function loadStoreFromDisk() {
    const file = storeFile()
    const stat = await statSafe(file)
    if (!stat || !stat.isFile()) return null
    const doc = await readJsonFile(file, null, log)
    if (!doc || typeof doc !== 'object') return null
    return { at: stat.mtimeMs, doc }
  }

  /** 只读缓存（/status、/library 用，绝不联网） */
  async function peekCatalog() {
    if (state.catalog) return state.catalog
    const disk = await loadCatalogFromDisk()
    if (disk) state.catalog = disk
    return state.catalog
  }

  async function peekStoreDoc() {
    if (state.storeDoc) return state.storeDoc
    const disk = await loadStoreFromDisk()
    if (disk) state.storeDoc = disk
    return state.storeDoc
  }

  /* ---------------------------------------------------------------- *
   * 拉取与刷新
   * ---------------------------------------------------------------- */

  async function downloadCatalog(repoName, auth) {
    const bytes = await fetchRepoFile({
      repo: repoName,
      path: 'catalog.json',
      auth,
      timeoutMs: CATALOG_TIMEOUT,
      maxBytes: CATALOG_MAX_BYTES,
      kind: 'catalog',
      log,
    })
    let doc
    try {
      doc = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new GameBenchError('资源库目录格式不正确，请稍后重试', 'NETWORK')
    }
    const games = catalogGamesOf(doc)
    if (!games) throw new GameBenchError('资源库目录格式不正确，请稍后重试', 'NETWORK')
    return { games, bytes }
  }

  async function downloadStore(repoName, auth) {
    const bytes = await fetchRepoFile({
      repo: repoName,
      path: 'store.json',
      auth,
      timeoutMs: CATALOG_TIMEOUT,
      maxBytes: STORE_MAX_BYTES,
      kind: 'catalog',
      log,
    })
    let doc
    try {
      doc = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new GameBenchError('资源库市场配置格式不正确，请稍后重试', 'NETWORK')
    }
    if (!doc || typeof doc !== 'object') throw new GameBenchError('资源库市场配置格式不正确，请稍后重试', 'NETWORK')
    return { doc, bytes }
  }

  /** 强制拉取 catalog + store，两个都成功才落盘（保留旧缓存） */
  function refreshData() {
    return dedupe('refresh', async () => {
      const repoName = await repo()
      const auth = await authFor(repoName)
      let catalogResult
      let storeResult
      try {
        ;[catalogResult, storeResult] = await Promise.all([
          downloadCatalog(repoName, auth),
          downloadStore(repoName, auth),
        ])
        await ensureDir(dataDir())
        await writeFileAtomic(catalogFile(), catalogResult.bytes, { mode: 0o644 })
        await writeFileAtomic(storeFile(), storeResult.bytes, { mode: 0o644 })
      } catch (err) {
        throw normalizeError(err)
      }
      const at = Date.now()
      state.catalog = { at, games: catalogResult.games }
      state.storeDoc = { at, doc: storeResult.doc }
      state.lastAttempt = 0
      setLastError('')
      return { cat: state.catalog, st: state.storeDoc }
    })
  }

  /**
   * 确保目录可用：优先内存，其次磁盘（TTL 内直接用）；过期则尝试刷新，失败继续用旧缓存。
   */
  async function ensureData({ force = false } = {}) {
    const cachedCatalog = state.catalog || (await loadCatalogFromDisk())
    const cachedStore = state.storeDoc || (await loadStoreFromDisk())

    const fresh =
      cachedCatalog &&
      cachedStore &&
      Date.now() - cachedCatalog.at < CACHE_TTL &&
      Date.now() - cachedStore.at < CACHE_TTL

    if (!force && fresh) {
      state.catalog = cachedCatalog
      state.storeDoc = cachedStore
      return { cat: cachedCatalog, st: cachedStore }
    }

    // 有旧缓存 + 刚失败过：冷却期内直接给旧缓存，避免离线时反复打 GitHub
    if (!force && cachedCatalog && Date.now() - state.lastAttempt < RETRY_COOLDOWN) {
      state.catalog = cachedCatalog
      if (cachedStore) state.storeDoc = cachedStore
      return { cat: cachedCatalog, st: cachedStore }
    }

    state.lastAttempt = Date.now()
    try {
      return await refreshData()
    } catch (err) {
      if (cachedCatalog) {
        const message = String(err?.message ?? err)
        setLastError(message)
        log('目录刷新失败，继续使用本地缓存', message.slice(0, 120))
        state.catalog = cachedCatalog
        if (cachedStore) state.storeDoc = cachedStore
        return { cat: cachedCatalog, st: cachedStore }
      }
      throw normalizeError(err)
    }
  }

  /* ---------------------------------------------------------------- *
   * 数据组装
   * ---------------------------------------------------------------- */

  const nesGamesOf = (games) =>
    (Array.isArray(games) ? games : []).filter(
      (game) => game && typeof game === 'object' && typeof game.id === 'string' && game.system === 'nes',
    )

  async function installedContext() {
    const library = await store.readLibrary()
    const libraryIds = new Set(library.games.map((game) => game.id))
    return { library, libraryIds, builtinIds: builtin.ids() }
  }

  function normMarketItem(game, context) {
    const id = String(game.id)
    const sha256 = shaOf(game)
    const sourceNames = Array.isArray(game.sourceNames)
      ? game.sourceNames.filter((item) => typeof item === 'string' && item.trim())
      : []
    const installed = context.builtinIds.has(id) || context.libraryIds.has(id)
    return {
      id,
      title: str(game.title).trim() || id,
      cover: `${ROUTE}/cover/${id}`,
      sha256,
      source: str(game.source).trim(),
      sourceNames: sourceNames.length ? sourceNames : [str(game.title).trim() || id],
      language: str(game.language).trim(),
      series: str(game.series).trim(),
      builtin: context.builtinIds.has(id),
      installed,
      featuredRank: Math.max(0, Math.round(num(game.featuredRank))),
    }
  }

  /* ---------------------------------------------------------------- *
   * 对外：/catalog
   * ---------------------------------------------------------------- */

  async function queryCatalog({ q = '', collection = '', offset = 0, limit = 60 } = {}) {
    const { cat, st } = await ensureData()
    let items = nesGamesOf(cat.games)

    if (collection) {
      const collections = Array.isArray(st?.doc?.collections) ? st.doc.collections : []
      const target = collections.find((item) => str(item?.id).trim() === collection)
      if (!target) {
        items = []
      } else {
        const byId = new Map(items.map((game) => [String(game.id), game]))
        items = (Array.isArray(target.gameIDs) ? target.gameIDs : [])
          .map((id) => byId.get(String(id)))
          .filter(Boolean)
      }
    }

    if (q) {
      const needle = q.toLowerCase()
      items = items.filter((game) => {
        const title = str(game.title).toLowerCase()
        if (title.includes(needle)) return true
        const names = Array.isArray(game.sourceNames) ? game.sourceNames : []
        return names.some((name) => str(name).toLowerCase().includes(needle))
      })
    }

    const total = items.length
    const start = Math.max(0, Math.round(num(offset)))
    const page = items.slice(start, start + limit)
    const context = await installedContext()
    return {
      total,
      offset: start,
      limit,
      items: page.map((game) => normMarketItem(game, context)),
    }
  }

  /* ---------------------------------------------------------------- *
   * 对外：/market
   * ---------------------------------------------------------------- */

  async function getMarketHome() {
    const { cat, st } = await ensureData()
    const games = nesGamesOf(cat.games)
    const byId = new Map(games.map((game) => [String(game.id), game]))
    const context = await installedContext()
    const doc = st?.doc

    const collections = (Array.isArray(doc?.collections) ? doc.collections : [])
      .map((collection) => {
        const ids = Array.isArray(collection?.gameIDs) ? collection.gameIDs : []
        const picked = ids.map((id) => byId.get(String(id))).filter(Boolean)
        return {
          id: str(collection?.id).trim(),
          title: str(collection?.title).trim() || str(collection?.id).trim(),
          description: str(collection?.description).trim(),
          total: picked.length,
          games: picked.slice(0, 8).map((game) => normMarketItem(game, context)),
        }
      })
      .filter((collection) => collection.id)

    const featured = games
      .filter((game) => num(game.featuredRank) > 0)
      .sort((a, b) => num(a.featuredRank) - num(b.featuredRank))
      .slice(0, 12)
      .map((game) => normMarketItem(game, context))

    const auth = peekAuth()
    return {
      title: str(doc?.title).trim() || MARKET_TITLE,
      libraryVersion: str(doc?.libraryVersion).trim(),
      total: games.length,
      auth: auth ? auth.kind : 'none',
      collections,
      featured,
    }
  }

  /** 只读合集（/library 计算 tags 用，不联网） */
  async function peekCollections() {
    const cached = await peekStoreDoc()
    const collections = cached?.doc?.collections
    return Array.isArray(collections) ? collections : []
  }

  /** /status 用：只读缓存，不联网 */
  async function peekStatus() {
    const cat = await peekCatalog()
    if (!cat) return { ready: false, count: 0, lastSync: null }
    return { ready: true, count: nesGamesOf(cat.games).length, lastSync: Math.round(cat.at) }
  }

  const lastError = () => state.lastError

  /** POST /sync：强制刷新，失败向上抛（旧缓存文件保持不变） */
  async function refreshAll() {
    try {
      const { cat, st } = await refreshData()
      const items = nesGamesOf(cat.games)
      const collections = Array.isArray(st?.doc?.collections) ? st.doc.collections : []
      const auth = peekAuth()
      return {
        total: items.length,
        collections: collections.length,
        lastSync: Math.round(cat.at),
        auth: auth ? auth.kind : 'none',
      }
    } catch (err) {
      const normalized = normalizeError(err)
      setLastError(normalized.message)
      throw normalized
    }
  }

  /* ---------------------------------------------------------------- *
   * 对外：ROM / 封面查找
   * ---------------------------------------------------------------- */

  async function findRom(id) {
    const builtinGame = builtin.find(id)
    if (builtinGame) return { path: builtinGame.romPath, builtin: true, size: builtinGame.size }
    const file = romPath(id)
    const stat = await statSafe(file)
    if (stat && stat.isFile()) return { path: file, builtin: false, size: stat.size }
    return null
  }

  async function findLocalCover(id) {
    const builtinGame = builtin.find(id)
    if (builtinGame?.coverPath) {
      if (await fileExists(builtinGame.coverPath)) return { path: builtinGame.coverPath, builtin: true }
    }
    const file = coverPath(id)
    if (await fileExists(file)) return { path: file, builtin: false }
    return null
  }

  /** 仅内存/磁盘目录（封面懒加载不主动拉 catalog，避免 img 请求触发 900KB 下载） */
  async function peekCatalogEntry(id) {
    const cat = await peekCatalog()
    if (!cat) return null
    return nesGamesOf(cat.games).find((game) => String(game.id) === id) || null
  }

  /* ---------------------------------------------------------------- *
   * 封面懒加载（并发上限 4 + in-flight 去重 + 失败缓存）
   * ---------------------------------------------------------------- */

  function acquireCoverSlot() {
    if (coverSlots.active < COVER_CONCURRENCY) {
      coverSlots.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => coverSlots.waiters.push(resolve)).then(() => {
      coverSlots.active += 1
    })
  }

  function releaseCoverSlot() {
    coverSlots.active = Math.max(0, coverSlots.active - 1)
    const next = coverSlots.waiters.shift()
    if (next) next()
  }

  async function ensureCover(id) {
    if (!ID_RE.test(id)) return null
    const local = await findLocalCover(id)
    if (local) return local

    const failedAt = coverFails.get(id)
    if (failedAt && Date.now() - failedAt < COVER_FAIL_TTL) return null

    const running = coverPromises.get(id)
    if (running) return running

    const task = (async () => {
      try {
        const entry = await peekCatalogEntry(id)
        const rel = cleanRelPath(entry?.cover)
        if (!rel) return null
        const repoName = await repo()
        const auth = await authFor(repoName)
        await acquireCoverSlot()
        let bytes
        try {
          bytes = await fetchRepoFile({
            repo: repoName,
            path: rel,
            auth,
            timeoutMs: 15_000,
            maxBytes: COVER_MAX_BYTES,
            kind: 'asset',
            log,
          })
        } finally {
          releaseCoverSlot()
        }
        await ensureDir(coverDir())
        await writeFileAtomic(coverPath(id), bytes, { mode: 0o644 })
        coverFails.delete(id)
        return { path: coverPath(id), builtin: false }
      } catch (err) {
        coverFails.set(id, Date.now())
        log('封面懒加载失败（降级为占位）', id.slice(0, 12), String(err?.message ?? err).slice(0, 100))
        return null
      }
    })().finally(() => coverPromises.delete(id))

    coverPromises.set(id, task)
    return task
  }

  /* ---------------------------------------------------------------- *
   * 对外：安装 / 卸载
   * ---------------------------------------------------------------- */

  function builtinAsLibraryGame(game) {
    return {
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
      tags: [],
      series: game.series,
      featuredRank: game.featuredRank,
    }
  }

  function libraryGame(entry, tags = []) {
    return {
      id: entry.id,
      title: entry.title,
      cover: `${ROUTE}/cover/${entry.id}`,
      rom: `${ROUTE}/rom/${entry.id}`,
      builtin: false,
      installed: true,
      size: entry.size,
      sha256: entry.sha256,
      source: entry.source,
      sourceNames: entry.sourceNames,
      language: entry.language,
      tags,
      series: entry.series,
      featuredRank: 0,
    }
  }

  async function tagsFor(id) {
    const collections = await peekCollections()
    const tags = []
    for (const collection of collections) {
      const ids = Array.isArray(collection?.gameIDs) ? collection.gameIDs : []
      if (!ids.some((item) => String(item) === id)) continue
      const title = str(collection?.title).trim()
      if (title && !tags.includes(title)) tags.push(title)
      if (tags.length >= 3) break
    }
    return tags
  }

  async function doInstall(id) {
    // 1) 已安装且 ROM 还在：幂等返回
    const library = await store.readLibrary()
    const existing = library.games.find((game) => game.id === id)
    if (existing && (await fileExists(romPath(id)))) {
      return {
        game: libraryGame(existing, await tagsFor(id)),
        bytes: existing.size,
        cover: await fileExists(coverPath(id)),
        alreadyInstalled: true,
      }
    }

    // 2) 从目录里找条目
    const { cat } = await ensureData()
    const entry = nesGamesOf(cat.games).find((game) => String(game.id) === id)
    if (!entry) throw new GameBenchError(ERROR_TEXT.NOT_FOUND, 'NOT_FOUND')

    const expectedSha = shaOf(entry)
    const romRel = cleanRelPath(entry.filename) || `owned/${expectedSha}.nes`
    const coverRel = cleanRelPath(entry.cover)
    const repoName = await repo()
    const auth = await authFor(repoName)

    let romWritten = false
    let coverWritten = false
    try {
      // 3) ROM 下载 + 校验 + 原子落盘
      const romBytes = await fetchRepoFile({
        repo: repoName,
        path: romRel,
        auth,
        timeoutMs: DOWNLOAD_TIMEOUT,
        maxBytes: ROM_MAX_BYTES,
        kind: 'asset',
        log,
      })
      const actualSha = sha256Hex(romBytes)
      if (actualSha !== expectedSha) {
        throw new GameBenchError(
          `文件校验失败（期望 ${expectedSha.slice(0, 12)}，实际 ${actualSha.slice(0, 12)}），已删除半成品，请重试`,
          'SHA_MISMATCH',
        )
      }
      await ensureDir(romDir())
      await writeFileAtomic(romPath(id), romBytes, { mode: 0o644 })
      romWritten = true

      // 4) 封面下载（失败不影响安装）
      let coverOk = false
      if (coverRel) {
        try {
          const coverBytes = await fetchRepoFile({
            repo: repoName,
            path: coverRel,
            auth,
            timeoutMs: DOWNLOAD_TIMEOUT,
            maxBytes: COVER_MAX_BYTES,
            kind: 'asset',
            log,
          })
          await ensureDir(coverDir())
          await writeFileAtomic(coverPath(id), coverBytes, { mode: 0o644 })
          coverWritten = true
          coverOk = true
        } catch (err) {
          log('封面下载失败（不影响安装）', id.slice(0, 12), String(err?.message ?? err).slice(0, 100))
        }
      }

      // 5) 更新 library.json
      const record = {
        id,
        title: str(entry.title).trim() || id,
        sha256: expectedSha,
        size: romBytes.length,
        source: str(entry.source).trim(),
        sourceNames: Array.isArray(entry.sourceNames) ? entry.sourceNames : [],
        language: str(entry.language).trim(),
        series: str(entry.series).trim(),
        author: str(entry.author).trim(),
        installedAt: Date.now(),
      }
      await store.addLibraryGame(record)
      return {
        game: libraryGame(record, await tagsFor(id)),
        bytes: romBytes.length,
        cover: coverOk,
        alreadyInstalled: false,
      }
    } catch (err) {
      // 失败清理半成品：删掉本次写下的文件（library.json 尚未写入）
      if (romWritten) await removeSafe(romPath(id))
      if (coverWritten) await removeSafe(coverPath(id))
      throw normalizeError(err)
    }
  }

  function install(id) {
    // 内置游戏（含自制 demo，id 不一定是 nes-<sha256>）始终视为已安装
    const builtinGame = builtin.find(id)
    if (builtinGame) {
      return Promise.resolve({
        game: builtinAsLibraryGame(builtinGame),
        bytes: builtinGame.size,
        cover: Boolean(builtinGame.cover),
        alreadyInstalled: true,
        builtin: true,
      })
    }
    if (!ID_RE.test(String(id || ''))) {
      return Promise.reject(new GameBenchError('游戏 id 格式不正确（应为 nes-<sha256>）', 'BAD_REQUEST'))
    }
    const running = installs.get(id)
    if (running) return running
    const task = doInstall(id).finally(() => installs.delete(id))
    installs.set(id, task)
    return task
  }

  async function uninstall(id) {
    if (builtin.find(id)) {
      // 内置 ROM 随包分发，不占本地缓存：按「无需卸载」处理，不报错
      return { id, removed: false, builtin: true }
    }
    if (!ID_RE.test(String(id || ''))) {
      throw new GameBenchError('游戏 id 格式不正确（应为 nes-<sha256>）', 'BAD_REQUEST')
    }
    const before = (await store.readLibrary()).games.some((game) => game.id === id)
    const hadFile = (await fileExists(romPath(id))) || (await fileExists(coverPath(id)))
    await removeSafe(romPath(id))
    await removeSafe(coverPath(id))
    await store.removeLibraryGame(id)
    coverFails.delete(id)
    return { id, removed: before || hadFile }
  }

  /* ---------------------------------------------------------------- *
   * 激活后后台预热（fire-and-forget）：让用户第一次开市场不用等网络
   * ---------------------------------------------------------------- */

  async function prefetch() {
    try {
      await ensureData()
      return true
    } catch (err) {
      const message = String(err?.message ?? err)
      setLastError(message)
      log('目录预热失败（不影响内置游戏）', message.slice(0, 120))
      return false
    }
  }

  /* ---------------------------------------------------------------- *
   * 设置里换仓库：清空目录缓存，避免旧仓库数据串味
   * ---------------------------------------------------------------- */

  async function resetCache() {
    state.catalog = null
    state.storeDoc = null
    state.lastAttempt = 0
    setLastError('')
    coverFails.clear()
    await removeSafe(catalogFile())
    await removeSafe(storeFile())
  }

  return {
    peekStatus,
    peekCollections,
    lastError,
    queryCatalog,
    getMarketHome,
    refreshAll,
    install,
    uninstall,
    findRom,
    findLocalCover,
    ensureCover,
    prefetch,
    resetCache,
  }
}
