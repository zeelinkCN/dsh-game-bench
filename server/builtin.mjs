/**
 * 内置游戏清单（games/*.nes + *.png，随插件包分发）。
 *
 * 两份清单合并：
 *  - games/builtin.json       可公开清单（只放作者自制 demo，随公开仓库分发）
 *  - games/builtin.local.json 本机私有清单（经典 ROM，gitignore，不随公开仓库分发）
 *    同 id 时 local 覆盖 public，其余追加；对外只暴露合并后、且 ROM 文件真实存在的条目。
 *
 * 职责：
 *  - 解析校验两份清单，合并、按 featuredRank 排序，提供查找、计数、ROM/封面绝对路径
 *  - 文件缺失/清单损坏/ROM 文件不存在时跳过该条而不是报错（/library 只列出可用条目）
 *
 * 上游：本地文件（games/ 由 scripts/pack-builtins.mjs 生成）
 * 降级：两份清单都不存在 => 0 款内置 + 日志；单条格式非法/文件缺失 => 跳过
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BUILTIN_DIR } from './paths.mjs'

/** 可公开清单（随仓库分发） */
export const PUBLIC_MANIFEST_FILE = join(BUILTIN_DIR, 'builtin.json')
/** 本机私有清单（gitignore；经典 ROM 不进公开仓库） */
export const LOCAL_MANIFEST_FILE = join(BUILTIN_DIR, 'builtin.local.json')

const SAFE_FILE_RE = /^[A-Za-z0-9._-]+$/
/** 内置游戏 id：市场游戏是 nes-<sha256>，自制 demo 可以是 starpilot 这类安全短 id */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

const num = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 校验并归一化一条内置记录；非法返回 null */
function normalizeBuiltin(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!SAFE_ID_RE.test(id)) return null
  const file = str(raw.file).trim()
  const cover = str(raw.cover).trim()
  // 只接受扁平文件名，防止清单里出现 ../ 之类的路径逃逸
  if (!SAFE_FILE_RE.test(file) || basename(file) !== file) return null
  if (cover && (!SAFE_FILE_RE.test(cover) || basename(cover) !== cover)) return null
  const sha256 = /^[0-9a-f]{64}$/.test(str(raw.sha256)) ? str(raw.sha256) : id.slice(4)
  const sourceNames = Array.isArray(raw.sourceNames)
    ? raw.sourceNames.map((item) => str(item).trim()).filter(Boolean)
    : []
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((item) => str(item).trim()).filter(Boolean).slice(0, 6)
    : []
  return {
    id,
    title: str(raw.title).trim() || id,
    file,
    cover,
    romPath: join(BUILTIN_DIR, file),
    coverPath: cover ? join(BUILTIN_DIR, cover) : '',
    sha256,
    size: Math.max(0, Math.round(num(raw.size))),
    source: str(raw.source).trim(),
    sourceNames: sourceNames.length ? sourceNames : [str(raw.title).trim() || id],
    author: str(raw.author).trim(),
    language: str(raw.language).trim(),
    series: str(raw.series).trim(),
    distribution: str(raw.distribution).trim(),
    tags,
    featuredRank: Math.max(0, Math.round(num(raw.featuredRank))),
  }
}

/** 清单文档 -> 归一化列表（非法条目不报错，直接丢弃） */
const listOf = (doc) => {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.games) ? doc.games : []
  return list.map(normalizeBuiltin).filter(Boolean)
}

/**
 * 合并公开清单与本机私有清单，并过滤掉 ROM 文件不存在的条目。
 *  - 同 id：local 覆盖 public
 *  - 排序：featuredRank 升序（0 视为没有排名，排在最后），同排名按标题
 *  - 封面文件缺失不隐藏游戏，只把 coverPath 置空（/cover 返回 404，前端画占位色块）
 *
 * @param {unknown} publicDoc games/builtin.json 解析结果（可为 null）
 * @param {unknown} localDoc  games/builtin.local.json 解析结果（可为 null）
 * @param {{ exists?: (path: string) => boolean, log?: (...args: any[]) => void }} [options] 便于自测注入
 */
export function mergeBuiltinManifests(publicDoc, localDoc, { exists = existsSync, log = null } = {}) {
  const merged = new Map()
  for (const doc of [publicDoc, localDoc]) {
    for (const game of listOf(doc)) merged.set(game.id, game)
  }

  const available = []
  let skipped = 0
  for (const game of merged.values()) {
    let romExists = false
    try {
      romExists = Boolean(exists(game.romPath))
    } catch {
      romExists = false
    }
    if (!romExists) {
      skipped += 1
      continue
    }
    if (game.coverPath) {
      let coverExists = false
      try {
        coverExists = Boolean(exists(game.coverPath))
      } catch {
        coverExists = false
      }
      if (!coverExists) {
        game.coverPath = ''
        game.cover = ''
      }
    }
    available.push(game)
  }

  if (skipped > 0 && typeof log === 'function') log(`内置清单有 ${skipped} 个条目的 ROM 文件缺失，已跳过`)

  const rankOf = (game) => (game.featuredRank > 0 ? game.featuredRank : Number.MAX_SAFE_INTEGER)
  available.sort((a, b) => rankOf(a) - rankOf(b) || a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return available
}

/**
 * @param {{ log?: (...args: any[]) => void }} [options]
 */
export function createBuiltin({ log = () => {} } = {}) {
  let games = null

  const readManifest = (file, { optional = false } = {}) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      if (err?.code === 'ENOENT') {
        if (!optional) log('缺少内置清单（公开）', String(file).split('/').pop())
        return null
      }
      log('读取内置清单失败（按缺失处理）', String(file).split('/').pop(), String(err?.message ?? err).slice(0, 120))
      return null
    }
  }

  function load() {
    if (games) return games
    const publicDoc = readManifest(PUBLIC_MANIFEST_FILE)
    const localDoc = readManifest(LOCAL_MANIFEST_FILE, { optional: true })
    games = mergeBuiltinManifests(publicDoc, localDoc, { log })
    if (!games.length) log('内置游戏清单为空（或 ROM 文件缺失），内置游戏降级为 0 款')
    return games
  }

  return {
    /** 全部可用内置游戏（按 featuredRank 升序；0 排名排最后） */
    list: () => load(),
    /** 游戏 id 集合 */
    ids: () => new Set(load().map((game) => game.id)),
    /** 按 id 查找内置游戏（ROM 文件存在的才返回） */
    find: (id) => load().find((game) => game.id === id) || null,
    /** 内置数量（只算文件齐全的条目） */
    count: () => load().length,
  }
}
