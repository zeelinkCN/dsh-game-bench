/**
 * GitHub 访问层：凭据解析 + 资源库文件下载。
 *
 * 职责：
 *  1. 按优先级解析 GitHub Token（结果内存缓存 10 分钟）：
 *       <dataDir>/settings.json 的 token  ->  GITHUB_TOKEN / GH_TOKEN  ->  `gh auth token`  ->  匿名 public raw 探测
 *     对外只暴露 { kind: 'settings'|'env'|'gh'|'public'|'none', token }，日志里绝不打印 token
 *  2. 下载资源库里的任意文件（catalog.json / store.json / owned/*.nes / covers/*.png）
 *     有 token 走 GitHub API（Accept: application/vnd.github.raw，私有仓库可用）；
 *     无 token 走 raw.githubusercontent.com（仅公开仓库）
 *  3. 把上游失败统一归类成 AUTH / NETWORK / NOT_FOUND / UNSUPPORTED，便于前端渲染错误态
 *
 * 上游：https://api.github.com、https://raw.githubusercontent.com、（可选）本机 `gh` 命令
 * 降级：
 *  - 传输层优先 `node:https` + 强制 IPv4（本机双栈网络里 IPv6 会 30s+ 卡死 api.github.com）；
 *    IPv4 解析失败时自动回退系统默认解析
 *  - https 出现 NETWORK 级失败时，若本机 `gh` 可用，回退到 `gh api ... -H Accept: application/vnd.github.raw`
 *    （已实测二进制字节与 SHA-256 完全正确）；成功过的传输方式在进程内优先复用
 *  - gh 命令缺失/未登录/超时（5s）一律视为「没有 gh token」，继续尝试匿名探测
 *  - 匿名探测失败（私有仓库返回 404、连不上）只影响 auth 标记，不影响插件激活
 *  - 不用全局 fetch（undici）：本机实测它会卡在 IPv6/连接策略上，30s 超时
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ERROR_TEXT, GameBenchError } from './errors.mjs'
import { formatBytes, readJsonFile } from './fsutil.mjs'
import { DEFAULT_REPO, REF, settingsFile } from './paths.mjs'

const USER_AGENT = 'DSH-GameBench/1.0'
const API_BASE = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'

/** Token 解析缓存时长：10 分钟（契约要求） */
const AUTH_TTL = 10 * 60 * 1000
/** `gh auth token` / `gh api` 超时 */
const GH_TIMEOUT = 5000
const GH_API_TIMEOUT = 20000
/** 匿名 public 探测超时 */
const PROBE_TIMEOUT = 6000
/** 目录类文件（900KB catalog）https 超过该时长仍未完成时，并行启动 gh 兜底（对冲突请求） */
const HEDGE_DELAY = 4000
/** 这些网络错误说明 IPv4 解析/路由不可用，回退系统默认解析再试一次 */
const FAMILY_FALLBACK_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'])

/** @type {{ at: number, kind: string, token: string, probedRepo: string } | null} */
let authCache = null
let authPending = null
/** 进程内记住跑通过的传输方式：'https' | 'gh' */
let preferredTransport = 'https'
/** 进程内记住可用的 gh 可执行文件路径（可能是不在 PATH 里的绝对路径） */
let ghCommandCache = ''
/** gh 是否已经探测过（探测失败也缓存，避免每次请求都 spawn） */
let ghChecked = false


/** 启动时环境里的显式 token（便于 /settings 展示 tokenSource，不对外暴露） */
const envToken = () => String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()

const safeLog = (log, ...args) => {
  try {
    if (typeof log === 'function') log(...args)
  } catch {
    /* 日志本身失败不影响流程 */
  }
}

/** 有 token 才算的上游访问凭据；public/none 都走匿名 */
export const hasToken = (auth) => Boolean(auth && auth.token)

/** 读取当前缓存的鉴权结果（可能为 null，不会触发解析） */
export function peekAuth() {
  return authCache
}

/** 当前鉴权方式（未解析时为 'none'） */
export function authKind() {
  return authCache ? authCache.kind : 'none'
}

/** 清空缓存：设置里改了 Token/仓库后调用 */
export function invalidateAuth() {
  authCache = null
  authPending = null
}

/**
 * 解析 GitHub 访问凭据（内存缓存 10 分钟）。
 * @param {{ repo?: string, log?: (...args: any[]) => void, force?: boolean }} [options]
 */
export async function resolveAuth({ repo, log = () => {}, force = false } = {}) {
  const repoName = String(repo || '').trim() || DEFAULT_REPO
  if (!force && authCache && Date.now() - authCache.at < AUTH_TTL) {
    const tokenKind = authCache.kind === 'settings' || authCache.kind === 'env' || authCache.kind === 'gh'
    // public/none 的探测结果与仓库绑定，换仓库后需要重新探测
    if (tokenKind || authCache.probedRepo === repoName) return authCache
  }
  if (!force && authPending) return authPending

  const task = (async () => {
    let token = ''
    let kind = ''

    // 1) 设置里粘贴的 Token
    const settings = await readJsonFile(settingsFile(), {}, log)
    const savedToken = typeof settings?.token === 'string' ? settings.token.trim() : ''
    if (savedToken) {
      token = savedToken
      kind = 'settings'
    }

    // 2) 环境变量
    if (!token) {
      const fromEnv = envToken()
      if (fromEnv) {
        token = fromEnv
        kind = 'env'
      }
    }

    // 3) 本机 gh CLI
    if (!token) {
      const fromGh = await ghAuthToken(log)
      if (fromGh) {
        token = fromGh
        kind = 'gh'
      }
    }

    // 4) 匿名探测：公开仓库可以匿名读 raw；私有仓库 404
    if (!token) {
      const pub = await probePublicRepo(repoName)
      kind = pub ? 'public' : 'none'
    }

    authCache = { at: Date.now(), kind, token, probedRepo: repoName }
    if (kind !== 'public') safeLog(log, `GitHub 鉴权方式：${kind}`)
    return authCache
  })().finally(() => {
    authPending = null
  })

  authPending = task
  return task
}

/* ------------------------------------------------------------------ *
 * gh CLI
 * ------------------------------------------------------------------ */

/** `gh` 可执行文件候选列表（Windows 上可能是 gh.exe；GUI 进程 PATH 常缺 homebrew/local bin） */
function ghCandidates(env = process.env) {
  const list = []
  if (process.platform === 'win32') {
    list.push('gh.exe', 'gh')
    const localAppData = String(env.LOCALAPPDATA || '').trim()
    if (localAppData) list.push(join(localAppData, 'GitHubCLI', 'bin', 'gh.exe'))
    const programFiles = String(env.ProgramFiles || '').trim()
    if (programFiles) list.push(join(programFiles, 'GitHub CLI', 'gh.exe'))
  } else {
    list.push('gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', join(homedir(), '.local', 'bin', 'gh'))
    if (process.platform === 'linux') list.push('/usr/bin/gh', '/snap/bin/gh')
  }
  return [...new Set(list)]
}

const execFileText = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 64 * 1024, shell: false, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))),
    )
  })

/** 以 Buffer 方式执行外部命令（`gh api` 下二进制不能走 utf8） */
const execFileBuffer = (command, args, timeout, maxBytes) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout,
        windowsHide: true,
        shell: false,
        encoding: 'buffer',
        maxBuffer: Math.max(2 * 1024 * 1024, maxBytes + 2 * 1024 * 1024),
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
          reject(err)
        } else {
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''))
        }
      },
    )
  })

/**
 * 找到一个可用的 gh 可执行文件并缓存（GUI 进程 PATH 常常没有 ~/.local/bin）。
 * 找不到返回 ''，调用方降级。
 */
async function resolveGhCommand(log = () => {}) {
  if (ghChecked) return ghCommandCache
  for (const command of ghCandidates()) {
    const isPath = command.includes('/') || command.includes('\\')
    if (isPath) {
      try {
        if (!existsSync(command)) continue
      } catch {
        continue
      }
    }
    try {
      await execFileText(command, ['--version'], 3000)
      ghCommandCache = command
      ghChecked = true
      return command
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        safeLog(log, 'gh 不可用（降级）', String(err?.code || err?.message || err).slice(0, 60))
      }
    }
  }
  ghChecked = true
  ghCommandCache = ''
  return ''
}

/** 取 gh auth token；任何失败都返回 ''（调用方继续降级），绝不抛 */
export async function ghAuthToken(log = () => {}) {
  const command = await resolveGhCommand(log)
  if (!command) return ''
  try {
    const stdout = await execFileText(command, ['auth', 'token'], GH_TIMEOUT)
    const token = stdout.trim()
    // 只接受形如 gho_xxx / github_pat_xxx 的 20+ 位 token，避免把报错文本当 token
    if (/^[A-Za-z0-9_.-]{20,255}$/.test(token)) return token
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      safeLog(log, 'gh auth token 不可用（降级）', String(err?.code || err?.message || err).slice(0, 60))
    }
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * 匿名探测
 * ------------------------------------------------------------------ */

/** 匿名 GET raw 上的 store.json，能 200 就说明仓库公开（不抛异常） */
async function probePublicRepo(repo) {
  try {
    const res = await httpGetBytes({
      url: `${RAW_BASE}/${repo}/${encodeURIComponent(REF)}/store.json`,
      headers: { 'User-Agent': USER_AGENT },
      timeoutMs: PROBE_TIMEOUT,
      maxBytes: 2 * 1024 * 1024,
    })
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 底层 HTTP（node:https；本机 undici fetch 访问 raw.githubusercontent 会超时）
 * ------------------------------------------------------------------ */

const asNetworkError = (err) => {
  if (err instanceof GameBenchError) return err
  const code = err?.code ? `（${err.code}）` : ''
  return new GameBenchError(`${ERROR_TEXT.NETWORK}${code}`, 'NETWORK', { cause: err })
}

/**
 * GET 一个 URL 并整段读入内存（node:https）。
 *  - 默认强制 IPv4（family: 4）：本机双栈网络里 IPv6 连接会卡死 api.github.com，实测 30s+ 超时
 *  - IPv4 解析/路由不可用时，自动回退系统默认解析（family: 0）再试一次
 *  - 硬超时覆盖 DNS/TCP 连接阶段；支持 Content-Length 与流式体积上限；最多跟随 3 次重定向
 * @returns {Promise<{ status: number, headers: Record<string, any>, body: Buffer }>}
 */
export async function httpGetBytes({
  url,
  headers = {},
  timeoutMs = 30000,
  maxBytes = 0,
  redirects = 3,
  family = 4,
  signal = null,
}) {
  try {
    return await httpGetAttempt({ url, headers, timeoutMs, maxBytes, redirects, family, signal })
  } catch (err) {
    const code = err?.cause?.code || err?.code
    if (family !== 0 && FAMILY_FALLBACK_CODES.has(code) && !signal?.aborted) {
      // IPv4 不可用（IPv6-only 网络）时回退系统默认解析
      return httpGetAttempt({ url, headers, timeoutMs, maxBytes, redirects, family: 0, signal })
    }
    throw err
  }
}

function httpGetAttempt({ url, headers, timeoutMs = 30000, maxBytes = 0, redirects = 3, family = 4, signal = null }) {
  return new Promise((resolve, reject) => {
    let settled = false
    /** 重定向交给内层请求后，外层定时器不再报错 */
    let handedOff = false
    let deadline = null
    let req = null

    const onAbort = () => {
      finish(new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK'))
      try {
        req?.destroy()
      } catch {
        /* 忽略 */
      }
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      if (signal) {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          /* 忽略 */
        }
      }
      if (error) reject(error)
      else resolve(value)
    }
    if (signal) {
      if (signal.aborted) {
        finish(new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK'))
        return
      }
      try {
        signal.addEventListener('abort', onAbort, { once: true })
      } catch {
        /* 忽略 */
      }
    }
    const tooLarge = () =>
      new GameBenchError(`文件超过大小限制（上限 ${formatBytes(maxBytes)}）`, 'UNSUPPORTED')

    let target
    try {
      target = new URL(url)
    } catch (err) {
      finish(asNetworkError(err))
      return
    }
    const transport = target.protocol === 'http:' ? http : https
    const requestOptions = { headers, autoSelectFamily: true }
    if (family === 4) requestOptions.family = 4

    try {
      req = transport.get(target, requestOptions, (res) => {
        const status = res.statusCode || 0
        const location = res.headers.location

        // 跟随重定向（GitHub raw 有时会 302 到 media.githubusercontent.com）
        if (status >= 300 && status < 400 && location && redirects > 0) {
          handedOff = true
          if (deadline) clearTimeout(deadline)
          res.resume()
          let next
          try {
            next = new URL(location, target)
          } catch (err) {
            finish(asNetworkError(err))
            return
          }
          httpGetBytes({ url: next.href, headers, timeoutMs, maxBytes, redirects: redirects - 1, family, signal }).then(
            (value) => finish(null, value),
            (err) => finish(err),
          )
          return
        }

        const declared = Number(res.headers['content-length'] || 0)
        if (maxBytes > 0 && declared > maxBytes) {
          res.resume()
          finish(tooLarge())
          try {
            req.destroy()
          } catch {
            /* 忽略 */
          }
          return
        }

        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          if (settled) return
          size += chunk.length
          if (maxBytes > 0 && size > maxBytes) {
            finish(tooLarge())
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => finish(null, { status, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', (err) => finish(asNetworkError(err)))
        res.on('aborted', () => finish(new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK')))
      })
    } catch (err) {
      finish(asNetworkError(err))
      return
    }

    req.on('error', (err) => finish(asNetworkError(err)))
    // 硬超时：用独立定时器，覆盖 DNS/TCP 连接阶段（request.setTimeout 只在 socket 建立后生效）
    deadline = setTimeout(() => {
      if (settled || handedOff) return
      finish(new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK'))
      try {
        req.destroy()
      } catch {
        /* 忽略 */
      }
    }, timeoutMs || 30000)
    deadline.unref?.()
  })
}

/* ------------------------------------------------------------------ *
 * 资源库文件下载
 * ------------------------------------------------------------------ */

/** 相对路径清洗：拒绝绝对路径、..、反斜杠与奇怪字符 */
export function cleanRelPath(value) {
  const text = String(value || '')
    .trim()
    .replace(/^\/+/, '')
  if (!text) return ''
  if (text.includes('..') || text.includes('\\') || text.includes('\0')) return ''
  if (!/^[A-Za-z0-9._/-]+$/.test(text)) return ''
  return text
}

const encodePath = (relPath) =>
  String(relPath)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')

/** HTTP 状态码 -> GameBenchError */
function classifyHttpError(status, { kind = 'asset', useApi = false }) {
  if (status === 401 || status === 403) return new GameBenchError(ERROR_TEXT.AUTH, 'AUTH')
  if (status === 404) {
    // 匿名请求私有仓库固定 404：没有 token 时按「需要访问权限」引导
    if (!useApi) return new GameBenchError(ERROR_TEXT.AUTH, 'AUTH')
    if (kind === 'catalog') {
      return new GameBenchError('资源库不可用：GitHub 仓库不存在或没有访问权限，请在设置里检查仓库名与 Token', 'AUTH')
    }
    return new GameBenchError(ERROR_TEXT.NOT_FOUND, 'NOT_FOUND')
  }
  if (status === 429) return new GameBenchError('GitHub 访问太频繁，请稍后重试', 'NETWORK')
  if (status === 400) return new GameBenchError('GitHub 拒绝了请求，请检查仓库名格式', 'BAD_REQUEST')
  if (status >= 500) return new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK')
  return new GameBenchError(`GitHub 返回了异常状态 ${status}，请稍后重试`, 'NETWORK')
}

/**
 * 通过本机 gh CLI 拉取资源库文件（https 传输被网络环境卡住时的兜底）。
 * 直接用 gh api ... -H "Accept: application/vnd.github.raw" 的 stdout 字节（二进制安全）。
 * @returns {Promise<Buffer>}
 */
export async function ghApiFetch({ repo, path, kind = 'asset', ref = REF, timeoutMs = GH_API_TIMEOUT, maxBytes = 8 * 1024 * 1024 }) {
  const repoName = String(repo || '').trim()
  if (!repoName) throw new GameBenchError('资源库仓库名未配置', 'BAD_REQUEST')
  const rel = cleanRelPath(path)
  if (!rel) throw new GameBenchError('资源库文件路径不合法', 'INTERNAL')
  const command = await resolveGhCommand()
  if (!command) throw new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK')

  const endpoint = `repos/${repoName}/contents/${rel}?ref=${encodeURIComponent(ref)}`
  let body
  try {
    body = await execFileBuffer(
      command,
      ['api', endpoint, '-H', 'Accept: application/vnd.github.raw', '-H', `User-Agent: ${USER_AGENT}`],
      timeoutMs,
      maxBytes,
    )
  } catch (err) {
    const text = String(err?.stderrText || '')
    if (/HTTP 40[13]/.test(text)) throw new GameBenchError(ERROR_TEXT.AUTH, 'AUTH', { cause: err })
    if (/HTTP 404/.test(text)) {
      if (kind === 'catalog') {
        throw new GameBenchError('资源库不可用：GitHub 仓库不存在或没有访问权限，请在设置里检查仓库名与 Token', 'AUTH', { cause: err })
      }
      throw new GameBenchError(ERROR_TEXT.NOT_FOUND, 'NOT_FOUND', { cause: err })
    }
    throw new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK', { cause: err })
  }
  if (maxBytes > 0 && body.length > maxBytes) {
    throw new GameBenchError(`文件超过大小限制（上限 ${formatBytes(maxBytes)}）`, 'UNSUPPORTED')
  }
  return body
}

/**
 * 对冲请求：primary（https）超过 delayMs 还没回就并行启动 fallback（gh），谁先成功用谁。
 * 兜底也失败（NETWORK）时立刻取消慢主路径判负，避免用户干等 45s。
 * 用于 900KB 的目录文件，网络抖动时可以把 30s+ 压缩到 ~5-20s。
 * @returns {Promise<{ value: Buffer, transport: 'https'|'gh' }>}
 */
function hedgeFetch({ primary, fallback, delayMs, label = '', log = null, cancelPrimary = null }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let fallbackStarted = false
    let primaryError = null
    let fallbackError = null
    let timer = null
    const settle = (error, value, transport) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve({ value, transport })
    }
    const startFallback = () => {
      if (fallbackStarted || settled) return
      fallbackStarted = true
      safeLog(log, `[hedge] ${label} 超过 ${delayMs}ms 未完成，启动 gh 兜底`)
      fallback().then(
        (value) => settle(null, value, 'gh'),
        (err) => {
          fallbackError = err
          safeLog(log, `[hedge] gh 兜底失败：${String(err?.code || err?.message || err).slice(0, 80)}`)
          if (primaryError) {
            settle(primaryError)
            return
          }
          // 兜底已给出结论：不再等慢主路径（取消它，让上层重试/换传输）
          try {
            if (typeof cancelPrimary === 'function') cancelPrimary()
          } catch {
            /* 忽略 */
          }
          settle(fallbackError)
        },
      )
    }
    timer = setTimeout(startFallback, delayMs)
    timer.unref?.()
    primary().then(
      (value) => settle(null, value, 'https'),
      (err) => {
        primaryError = err
        if (fallbackStarted) settle(fallbackError || err)
        else settle(err)
      },
    )
  })
}

/**
 * 从资源库下载一个文件。
 *
 * 传输策略（进程内记忆）：
 *  1. 首选 node:https（强制 IPv4）：有 token 走 api.github.com，无 token 走 raw.githubusercontent.com
 *  2. https 出现 NETWORK 级失败且本机 gh 可用时，回退 gh api（二进制安全）
 *  3. 成功过的传输方式会被记住，后续请求优先复用；失败自动回退另一种
 *
 * @param {{
 *   repo: string,
 *   path: string,
 *   auth: { kind?: string, token?: string },
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   kind?: 'catalog'|'asset',
 *   ref?: string,
 *   log?: (...args: any[]) => void,
 * }} options
 * @returns {Promise<Buffer>}
 */
export async function fetchRepoFile({
  repo,
  path,
  auth,
  timeoutMs = 30000,
  maxBytes = 8 * 1024 * 1024,
  kind = 'asset',
  ref = REF,
  log = () => {},
}) {
  const repoName = String(repo || '').trim()
  if (!repoName) throw new GameBenchError('资源库仓库名未配置', 'BAD_REQUEST')
  const rel = cleanRelPath(path)
  if (!rel) throw new GameBenchError('资源库文件路径不合法', 'INTERNAL')

  const token = String(auth?.token || '')
  const useApi = Boolean(token)
  const url = useApi
    ? `${API_BASE}/repos/${repoName}/contents/${encodePath(rel)}?ref=${encodeURIComponent(ref)}`
    : `${RAW_BASE}/${repoName}/${encodeURIComponent(ref)}/${encodePath(rel)}`
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: useApi ? 'application/vnd.github.raw' : '*/*',
  }
  if (useApi) headers.Authorization = `Bearer ${token}`

  const order = preferredTransport === 'gh' ? ['gh', 'https'] : ['https', 'gh']
  let lastError = null
  for (const transport of order) {
    const startedAt = Date.now()
    try {
      if (transport === 'https') {
        const primary = async () => {
          let res
          try {
            res = await httpGetBytes({ url, headers, timeoutMs, maxBytes })
          } catch (err) {
            throw asNetworkError(err)
          }
          if (res.status < 200 || res.status >= 300) {
            throw classifyHttpError(res.status, { kind, useApi })
          }
          return res.body
        }

        // 目录/市场配置这类大文件：https 6s 未完成就并行用 gh 兜底，取先完成的
        if (kind === 'catalog') {
          const ghCommand = await resolveGhCommand(log)
          if (ghCommand) {
            const { value, transport: winner } = await hedgeFetch({
              primary,
              fallback: () =>
                ghApiFetch({
                  repo: repoName,
                  path: rel,
                  kind,
                  ref,
                  timeoutMs: Math.min(timeoutMs, GH_API_TIMEOUT),
                  maxBytes,
                }),
              delayMs: HEDGE_DELAY,
              label: rel,
              log,
            })
            preferredTransport = winner
            logTransport(log, winner, { rel, bytes: value.length, ms: Date.now() - startedAt, kind })
            return value
          }
        }

        const body = await primary()
        preferredTransport = 'https'
        logTransport(log, 'https', { rel, bytes: body.length, ms: Date.now() - startedAt, kind })
        return body
      }

      const body = await ghApiFetch({ repo: repoName, path: rel, kind, ref, timeoutMs: Math.min(timeoutMs, GH_API_TIMEOUT), maxBytes })
      preferredTransport = 'gh'
      logTransport(log, 'gh', { rel, bytes: body.length, ms: Date.now() - startedAt, kind })
      return body
    } catch (err) {
      lastError = err instanceof GameBenchError ? err : asNetworkError(err)
      // 只有"传输失败"才换另一条链路；AUTH / NOT_FOUND / UNSUPPORTED 是语义结果，换链路也一样
      if (lastError.code !== 'NETWORK') throw lastError
      logTransport(log, `${transport} 失败，回退下一传输`, { rel, kind, error: lastError.message })
    }
  }
  throw lastError || new GameBenchError(ERROR_TEXT.NETWORK, 'NETWORK')
}

/** 传输日志：只打印「用了哪条传输 + 耗时 + 字节数」，绝不打印 token */
function logTransport(log, transport, { rel, bytes, ms, kind, error }) {
  try {
    if (typeof log !== 'function') return
    if (kind === 'catalog') {
      log(`[transport=${transport}] ${rel} ${bytes ?? 0}B ${ms ?? 0}ms`)
    } else if (transport !== 'https') {
      log(`[transport=${transport}] ${rel} ${bytes ?? 0}B ${ms ?? 0}ms${error ? ` ${String(error).slice(0, 60)}` : ''}`)
    }
  } catch {
    /* 日志失败忽略 */
  }
}
