/**
 * 路径解析：插件根目录、数据目录、各类文件位置。
 *
 * 数据目录（跨平台）：
 *  1. 环境变量 DSH_GAME_BENCH_DATA 优先
 *  2. macOS   ~/Library/Application Support/DSH Game Bench
 *  3. Windows %APPDATA%\DSH Game Bench
 *  4. Linux   $XDG_DATA_HOME/dsh-game-bench 或 ~/.local/share/dsh-game-bench
 *
 * 说明：只做纯计算，不创建目录、不抛异常；数据目录惰性求值并缓存一次，
 *      解析失败时回落到「用户主目录/.dsh-game-bench」，保证插件永远能激活。
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '1.1.0'

/** Host API 前缀（与 docs/API.md 一致，前端同源调用） */
export const ROUTE = '/game-bench/api'

/** 私有资源库默认仓库 */
export const DEFAULT_REPO = 'zeelinkCN/game-bench-library'

/** 资源库分支 */
export const REF = 'main'

/** 插件包根目录（index.js 所在目录） */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 内置游戏目录（ROM + 封面 + builtin.json） */
export const BUILTIN_DIR = join(PLUGIN_ROOT, 'games')

/** 内置清单文件 */
export const BUILTIN_MANIFEST_FILE = join(BUILTIN_DIR, 'builtin.json')

/** 随包分发的 jsnes 运行时 */
export const VENDOR_FILE = join(PLUGIN_ROOT, 'vendor', 'jsnes.min.js')

/** 自研模拟器封装 */
export const ENGINE_FILE = join(PLUGIN_ROOT, 'engine.js')
export const GAMEPADS_FILE = join(PLUGIN_ROOT, 'gamepads.js')
export const GAMEPAD_SETTINGS_FILE = join(PLUGIN_ROOT, 'gamepad-settings.js')

/** 游戏 id 规范：nes-<64 位小写十六进制 sha256> */
export const ID_RE = /^nes-[0-9a-f]{64}$/

/** 数据目录（惰性求值，进程内缓存一次） */
let dataDirCache = ''

const envText = (env, key) => {
  const value = env && typeof env === 'object' ? env[key] : ''
  return typeof value === 'string' ? value.trim() : ''
}

/** 纯函数：按平台规则计算数据目录（便于单测与环境变量覆盖） */
export function resolveDataDir(env = process.env) {
  const override = envText(env, 'DSH_GAME_BENCH_DATA')
  if (override) return resolve(override)

  const home = (() => {
    try {
      return homedir()
    } catch {
      return ''
    }
  })()

  if (process.platform === 'darwin') {
    return join(home || '.', 'Library', 'Application Support', 'DSH Game Bench')
  }
  if (process.platform === 'win32') {
    const appData = envText(env, 'APPDATA')
    return join(appData || join(home || '.', 'AppData', 'Roaming'), 'DSH Game Bench')
  }
  const xdg = envText(env, 'XDG_DATA_HOME')
  return join(xdg || join(home || '.', '.local', 'share'), 'dsh-game-bench')
}

/** 当前生效的数据目录 */
export function dataDir() {
  if (!dataDirCache) {
    try {
      dataDirCache = resolveDataDir()
    } catch {
      dataDirCache = join(homedir(), '.dsh-game-bench')
    }
  }
  return dataDirCache
}

/** 市场目录缓存（首次拉取落盘，TTL 24h） */
export const catalogFile = () => join(dataDir(), 'catalog.json')

/** 市场合集定义 */
export const storeFile = () => join(dataDir(), 'store.json')

/** 本地已下载游戏清单 */
export const libraryFile = () => join(dataDir(), 'library.json')

/** 用户设置（含 GitHub Token，权限 0600） */
export const settingsFile = () => join(dataDir(), 'settings.json')

/** 已下载 ROM 缓存目录 */
export const romDir = () => join(dataDir(), 'roms')

/** 已下载封面缓存目录 */
export const coverDir = () => join(dataDir(), 'covers')

/** 单款游戏 ROM 落盘路径 */
export const romPath = (id) => join(romDir(), `${id}.nes`)

/** 单款游戏封面落盘路径 */
export const coverPath = (id) => join(coverDir(), `${id}.png`)

/** 测试/诊断用：清掉数据目录缓存（正常运行时不需要） */
export function __resetDataDirForTests() {
  dataDirCache = ''
}
