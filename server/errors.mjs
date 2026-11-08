/**
 * 统一错误类型与中文文案（对应 docs/API.md 第 13 节错误码表）。
 *
 * 职责：
 *  - 所有模块只抛 GameBenchError，由 http.mjs 统一转成 { ok:false, error, code } 信封
 *  - 文案一律「人话中文」，避免把底层英文异常直接怼给用户
 *
 * 上游：无（纯本地）
 * 降级：任何未知错误一律归为 INTERNAL，不会中断插件
 */

/** 错误码 -> 中文文案（API.md 第 13 节） */
export const ERROR_TEXT = {
  AUTH: '市场需要 GitHub 访问权限，请在设置里粘贴 Token，或先执行 gh auth login',
  NETWORK: '连不上 GitHub，请检查网络后重试（内置游戏不受影响）',
  NOT_FOUND: '找不到这款游戏，可能已从资源库移除',
  SHA_MISMATCH: '文件校验失败，已删除半成品，请重试',
  UNSUPPORTED: '暂不支持这个平台',
  INTERNAL: '出现意外错误',
  BAD_REQUEST: '请求参数有误',
}

/** 错误码 -> HTTP 状态码 */
const HTTP_STATUS = {
  BAD_REQUEST: 400,
  AUTH: 401,
  NOT_FOUND: 404,
  NETWORK: 502,
  SHA_MISMATCH: 502,
  UNSUPPORTED: 400,
  INTERNAL: 500,
}

export class GameBenchError extends Error {
  /**
   * @param {string} [message] 中文人话文案；缺省时用错误码的默认文案
   * @param {(keyof ERROR_TEXT)} [code] 错误码
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code = 'INTERNAL', options = {}) {
    const safeCode = Object.hasOwn(ERROR_TEXT, code) ? code : 'INTERNAL'
    super(typeof message === 'string' && message.trim() ? message : ERROR_TEXT[safeCode])
    this.name = 'GameBenchError'
    this.code = safeCode
    if (options && options.cause !== undefined) this.cause = options.cause
  }
}

export const errorText = (code) => ERROR_TEXT[code] || ERROR_TEXT.INTERNAL

export const statusFor = (code) => HTTP_STATUS[code] || 500

export const isKnownCode = (code) => typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code)
