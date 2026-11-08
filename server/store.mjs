/**
 * 本地持久化：<dataDir>/library.json（已下载游戏清单）与 <dataDir>/settings.json（用户设置）。
 *
 * 职责：
 *  - library.json 读-改-写（单队列串行，杜绝并发安装/卸载互相覆盖）
 *  - settings.json 读写（含 GitHub Token，权限 0600；Token 只写不读不回显）
 *  - 两个文件缺失/损坏时降级为空清单 / 默认设置，不抛异常
 *
 * 上游：无（纯本地文件）
 * 降级：读取失败 => 空 / 默认；写入失败向上抛给路由层，由调用方转成 INTERNAL
 */
import { promises as fsp } from 'node:fs'
import { GameBenchError } from './errors.mjs'
import { createSerialQueue, ensureDir, readJsonFile, writeJsonAtomic } from './fsutil.mjs'
import { DEFAULT_REPO, ID_RE, dataDir, libraryFile, settingsFile } from './paths.mjs'

const LIBRARY_VERSION = 1
const SETTINGS_VERSION = 1

/** 仓库名格式：owner/name */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 归一化 library.json 中的一条记录；非法返回 null */
function normalizeLibraryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!ID_RE.test(id)) return null
  const title = str(raw.title).trim() || id
  const sha256 = /^[0-9a-f]{64}$/.test(str(raw.sha256)) ? str(raw.sha256) : id.slice(4)
  const sourceNames = Array.isArray(raw.sourceNames)
    ? raw.sourceNames.map((item) => str(item).trim()).filter(Boolean)
    : []
  return {
    id,
    title,
    sha256,
    size: Math.max(0, Math.round(num(raw.size))),
    source: str(raw.source).trim(),
    sourceNames: sourceNames.length ? sourceNames : [title],
    language: str(raw.language).trim(),
    series: str(raw.series).trim(),
    author: str(raw.author).trim(),
    installedAt: Math.max(0, Math.round(num(raw.installedAt))),
  }
}

/** 设置归一化：只保留认识的字段，Token 永不进日志 */
function normalizeSettings(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {}
  const repo = str(doc.repo).trim()
  return {
    repo: REPO_RE.test(repo) ? repo : DEFAULT_REPO,
    token: typeof doc.token === 'string' ? doc.token.trim() : '',
  }
}

/**
 * @param {{ log?: (...args: any[]) => void }} [options]
 */
export function createStore({ log = () => {} } = {}) {
  const libraryQueue = createSerialQueue()
  const settingsQueue = createSerialQueue()
  /** @type {Array|null} 内存缓存（写操作后同步更新，避免 900KB 级重复读盘不存在，这里只是小文件） */
  let libraryCache = null

  async function readLibrary() {
    if (libraryCache) return { version: LIBRARY_VERSION, games: libraryCache.map((game) => ({ ...game })) }
    const doc = await readJsonFile(libraryFile(), null, log)
    const list = Array.isArray(doc) ? doc : Array.isArray(doc?.games) ? doc.games : []
    const seen = new Set()
    const games = []
    for (const raw of list) {
      const game = normalizeLibraryEntry(raw)
      if (!game || seen.has(game.id)) continue
      seen.add(game.id)
      games.push(game)
    }
    libraryCache = games
    return { version: LIBRARY_VERSION, games: games.map((game) => ({ ...game })) }
  }

  async function persistLibrary(games) {
    libraryCache = games.map((game) => ({ ...game }))
    await ensureDir(dataDir())
    await writeJsonAtomic(
      libraryFile(),
      { version: LIBRARY_VERSION, updatedAt: Date.now(), games: libraryCache },
      { mode: 0o644 },
    )
  }

  /** 在单队列里做「读 -> 改 -> 写」 */
  function mutateLibrary(mutator) {
    return libraryQueue(async () => {
      const current = await readLibrary()
      const next = mutator(current.games)
      await persistLibrary(next)
      return { version: LIBRARY_VERSION, games: next.map((game) => ({ ...game })) }
    })
  }

  async function addLibraryGame(payload) {
    const game = normalizeLibraryEntry(payload)
    if (!game) throw new GameBenchError('安装记录格式不正确', 'INTERNAL')
    return mutateLibrary((games) => [...games.filter((item) => item.id !== game.id), game])
  }

  async function removeLibraryGame(id) {
    return mutateLibrary((games) => games.filter((item) => item.id !== id))
  }

  async function readSettings() {
    const doc = await readJsonFile(settingsFile(), {}, log)
    return normalizeSettings(doc)
  }

  /** settings 里的 repo 非法时回落到默认仓库 */
  const repoOf = (settings) => {
    const repo = str(settings?.repo).trim()
    return REPO_RE.test(repo) ? repo : DEFAULT_REPO
  }

  /** 只写不读：patch 里出现的字段才覆盖，其余保持原值 */
  async function writeSettings(patch = {}) {
    return settingsQueue(async () => {
      const current = await readSettings()
      const next = {
        version: SETTINGS_VERSION,
        repo: REPO_RE.test(str(patch.repo).trim()) ? str(patch.repo).trim() : current.repo,
        token: typeof patch.token === 'string' ? patch.token.trim() : current.token,
        updatedAt: Date.now(),
      }
      await ensureDir(dataDir())
      // Token 落盘权限 0600：原子写时临时文件就是 0600，rename 后保持
      await writeJsonAtomic(settingsFile(), next, { mode: 0o600 })
      // 额外兜底：某些平台 rename 不继承 mode 时再 chmod 一次
      try {
        await fsp.chmod(settingsFile(), 0o600)
      } catch {
        /* Windows 上 chmod 语义有限，失败忽略 */
      }
      return normalizeSettings(next)
    })
  }

  return {
    readLibrary,
    addLibraryGame,
    removeLibraryGame,
    readSettings,
    writeSettings,
    repoOf,
  }
}
