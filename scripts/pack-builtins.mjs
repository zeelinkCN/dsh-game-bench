#!/usr/bin/env node
/**
 * 拾光游戏厅 · 内置游戏打包脚本
 *
 * 职责：
 *  从本地资源库副本（默认 .lead-tmp/gb/library，可用 GAMEBENCH_LIBRARY_DIR / --library 覆盖）
 *  按 catalog.json 的 featuredRank 取前 N 款（默认 7），把 ROM 与封面拷进插件的 games/ 目录，
 *  并生成本机私有清单 games/builtin.local.json（经典 ROM 只在本机生效，不进公开仓库）。
 *  可公开的 games/builtin.json（作者自制 demo）不归本脚本管，保持原样。
 *
 * 幂等：
 *  - ROM/封面已存在且 SHA-256 一致时跳过拷贝（--force 强制覆盖）
 *  - builtin.local.json 内容未变化时不重写，保证重复执行字节级一致
 *
 * 用法：
 *  node scripts/pack-builtins.mjs [--count 7] [--force] [--library <dir>] [--help]
 *
 * 退出码：0 成功；1 参数错误 / 数据缺失 / 校验失败
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const GAMES_DIR = join(PLUGIN_ROOT, 'games')
const MANIFEST_FILE = join(GAMES_DIR, 'builtin.local.json')
const DEFAULT_LIBRARY = resolve(PLUGIN_ROOT, '..', '.lead-tmp', 'gb', 'library')
const DEFAULT_COUNT = 7

const usage = () => {
  console.log(`用法: node scripts/pack-builtins.mjs [选项]

选项:
  --count <n>       取 featuredRank 前 n 款（默认 ${DEFAULT_COUNT}）
  --library <dir>   资源库本地副本目录（默认 $GAMEBENCH_LIBRARY_DIR 或 ${DEFAULT_LIBRARY}）
  --force           即使 ROM/封面已存在也重新拷贝
  （产出：games/<id>.nes、games/<id>.png、games/builtin.local.json；不动 games/builtin.json）
  -h, --help        显示帮助`)
}

const parseArgs = (argv) => {
  const options = {
    count: DEFAULT_COUNT,
    library: String(process.env.GAMEBENCH_LIBRARY_DIR || '').trim() || DEFAULT_LIBRARY,
    force: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') options.force = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--count') {
      const value = Number(argv[i + 1])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--count 需要正整数，收到 ${String(argv[i + 1])}`)
      options.count = value
      i += 1
    } else if (arg === '--library') {
      const value = String(argv[i + 1] || '').trim()
      if (!value) throw new Error('--library 需要目录路径')
      options.library = resolve(value)
      i += 1
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

/** 与既有 games/builtin.json 完全一致的字段顺序 */
const toManifestGame = (entry, { size }) => ({
  id: entry.id,
  title: str(entry.title).trim(),
  file: `${entry.id}.nes`,
  cover: `${entry.id}.png`,
  sha256: entry.sha256 || String(entry.id).slice(4),
  size,
  source: str(entry.source),
  sourceNames: Array.isArray(entry.sourceNames) && entry.sourceNames.length ? entry.sourceNames : [str(entry.title).trim()],
  author: str(entry.author),
  language: str(entry.language),
  series: str(entry.series),
  distribution: str(entry.distribution),
  featuredRank: Number(entry.featuredRank) || 0,
})

/** 原子拷贝：先写 .tmp 再 rename，避免中途失败留下半个文件 */
const copyAtomic = (source, target) => {
  const tmp = `${target}.${process.pid}.tmp`
  copyFileSync(source, tmp)
  renameSync(tmp, target)
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return 0
  }

  const catalogFile = join(options.library, 'catalog.json')
  if (!existsSync(catalogFile)) {
    throw new Error(`资源库目录里没有 catalog.json：${catalogFile}`)
  }

  let catalog
  try {
    catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))
  } catch (err) {
    throw new Error(`解析 catalog.json 失败：${err.message}`)
  }
  const games = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.games) ? catalog.games : null
  if (!games) throw new Error('catalog.json 结构不正确（应为数组或 { games: [] }）')

  const featured = games
    .filter((game) => game && typeof game === 'object' && game.system === 'nes' && Number(game.featuredRank) > 0)
    .sort((a, b) => Number(a.featuredRank) - Number(b.featuredRank))
    .slice(0, options.count)

  if (!featured.length) throw new Error('catalog 里没有 featuredRank > 0 的 NES 游戏')
  if (featured.length < options.count) {
    console.warn(`[pack-builtins] 目录里只有 ${featured.length} 款精选，少于要求的 ${options.count}`)
  }

  mkdirSync(GAMES_DIR, { recursive: true })

  const manifest = { version: 1, games: [] }
  let copied = 0
  let skipped = 0

  for (const entry of featured) {
    const id = String(entry.id || '').trim()
    if (!/^nes-[0-9a-f]{64}$/.test(id)) throw new Error(`非法的游戏 id：${id}`)
    const expectedSha = /^[0-9a-f]{64}$/.test(str(entry.sha256)) ? str(entry.sha256) : id.slice(4)
    const romSource = join(options.library, str(entry.filename) || `owned/${expectedSha}.nes`)
    const coverSource = join(options.library, str(entry.cover) || `covers/${expectedSha}.png`)
    if (!existsSync(romSource)) throw new Error(`缺少 ROM 文件：${romSource}`)
    if (!existsSync(coverSource)) throw new Error(`缺少封面文件：${coverSource}`)

    const romBuffer = readFileSync(romSource)
    const actualSha = sha256(romBuffer)
    if (actualSha !== expectedSha) {
      throw new Error(`ROM 校验失败：${romSource}\n  期望 ${expectedSha}\n  实际 ${actualSha}`)
    }

    const romTarget = join(GAMES_DIR, `${id}.nes`)
    const coverTarget = join(GAMES_DIR, `${id}.png`)
    const romUpToDate =
      !options.force && existsSync(romTarget) && statSync(romTarget).size === romBuffer.length && sha256(readFileSync(romTarget)) === expectedSha
    const coverUpToDate =
      !options.force && existsSync(coverTarget) && statSync(coverTarget).size === statSync(coverSource).size

    if (romUpToDate) skipped += 1
    else copied += 1
    if (!romUpToDate) copyAtomic(romSource, romTarget)
    if (!coverUpToDate) copyAtomic(coverSource, coverTarget)

    manifest.games.push(toManifestGame({ ...entry, sha256: expectedSha }, { size: romBuffer.length }))
    console.log(
      `[pack-builtins] ${romUpToDate ? '跳过' : '写入'} ${entry.title}（${id.slice(0, 12)}…，ROM ${romBuffer.length}B${coverUpToDate ? '' : '，封面已更新'}）`,
    )
  }

  const nextText = JSON.stringify(manifest, null, 2)
  const currentText = existsSync(MANIFEST_FILE) ? readFileSync(MANIFEST_FILE, 'utf8') : ''
  const manifestChanged = currentText !== nextText
  if (manifestChanged) writeFileSync(MANIFEST_FILE, nextText)

  console.log(
    `[pack-builtins] 完成：${manifest.games.length} 款（写入 ${copied} / 跳过 ${skipped}），` +
      `games/builtin.local.json ${manifestChanged ? '已更新' : '未变化'}`,
  )
  return 0
}

try {
  process.exitCode = main()
} catch (err) {
  console.error('[pack-builtins] 失败：', err?.message || err)
  process.exitCode = 1
}
