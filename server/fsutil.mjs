/**
 * 文件系统小工具：原子写、JSON 读写、串行队列、SHA-256。
 *
 * 设计要点：
 *  - 写文件一律「同目录 .tmp + rename」，避免断电/并发写坏 library.json、catalog.json
 *  - 读文件失败（缺失/损坏/权限）一律降级为 fallback，不抛异常到插件层
 *  - createSerialQueue 用于把 library.json 的读-改-写串成单队列，杜绝竞态
 *
 * 上游：无（纯本地）
 * 降级：只读失败返回 null / fallback；写入失败由调用方决定是否记录日志
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** sha256（十六进制小写） */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 递归建目录；失败返回 false，不抛 */
export async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 文件是否存在 */
export async function fileExists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** stat 安全版：失败返回 null */
export async function statSafe(file) {
  try {
    return await fsp.stat(file)
  } catch {
    return null
  }
}

/** 读取整个文件；失败返回 null */
export async function readFileSafe(file) {
  try {
    return await fsp.readFile(file)
  } catch {
    return null
  }
}

/** 读取 JSON 文件；缺失/损坏/类型不符一律返回 fallback */
export async function readJsonFile(file, fallback = null, log = null) {
  const raw = await readFileSafe(file)
  if (!raw) return fallback
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (err) {
    if (typeof log === 'function') log('JSON 解析失败，按缺失处理', String(file).split('/').pop(), String(err?.message ?? err).slice(0, 80))
    return fallback
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * @param {string} target 目标文件
 * @param {string|Buffer|Uint8Array} data 内容
 * @param {{ mode?: number }} [options] 新建文件时的权限（rename 后保持）
 */
export async function writeFileAtomic(target, data, options = {}) {
  const dir = dirname(target)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(tmp, data, options && options.mode ? { mode: options.mode } : undefined)
    await fsp.rename(tmp, target)
  } catch (err) {
    try {
      await fsp.rm(tmp, { force: true })
    } catch {
      /* 清理失败忽略 */
    }
    throw err
  }
}

/** 原子写 JSON（2 空格缩进，便于人工排查） */
export async function writeJsonAtomic(target, value, options = {}) {
  return writeFileAtomic(target, Buffer.from(JSON.stringify(value, null, 2), 'utf8'), options)
}

/** 删除文件；返回是否确实删掉了（ENOENT 返回 false） */
export async function removeSafe(target) {
  if (!(await fileExists(target))) return false
  try {
    await fsp.rm(target, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 单队列串行执行器：把读-改-写串起来，前一个失败不阻塞后一个。
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
export function createSerialQueue() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/** 人类可读的字节数（错误提示用） */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}
