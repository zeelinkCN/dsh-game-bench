/**
 * 拾光游戏厅（Game Bench）· DeepSeek Harness 插件（Host 侧）
 *
 * 职责：
 *  1. /game-bench/api/* 同源 HTTP 接口：游戏库、市场目录、安装/卸载、ROM/封面分发、设置
 *  2. 随包分发 7 款内置红白机游戏（games/*.nes + *.png + builtin.json），断网即开即玩
 *  3. 代理私有 GitHub 资源库（zeelinkCN/game-bench-library）：catalog.json / store.json 缓存 24h、
 *     ROM/封面按需下载并做 SHA-256 校验，落盘到用户数据目录
 *  4. 向前端提供 /vendor/jsnes.js 与 /engine.js 两个模拟器运行时静态文件
 *
 * 上游：
 *  - 本地：<dataDir>/library.json、settings.json、catalog.json、store.json、roms/、covers/
 *  - 远端：GitHub API（有 token）/ raw.githubusercontent.com（匿名，仅公开仓库）
 *  - 鉴权：settings.json token -> GITHUB_TOKEN/GH_TOKEN -> 本机 `gh auth token` -> 匿名探测
 *
 * 传输策略：node:https + 强制 IPv4（本机 IPv6 会卡死 api.github.com），失败回退本机 gh api；
 *          进程内记住跑通的传输方式并优先复用（详见 server/github.mjs）。
 *
 * 降级策略（任何一条都不允许阻塞插件激活）：
 *  - apply 全程 try/catch，路由逐个注册、单个失败只记日志；ctx.effect 负责统一释放
 *  - /status 永远 200，内部异常回落到兜底数据
 *  - 目录刷新失败保留旧缓存；封面/运行时文件缺失只返回 404，由前端画占位
 *  - 数据目录按需 mkdir -p，创建失败也能只读运行
 *  - 激活后后台预热市场目录（fire-and-forget），失败只 log，不影响激活与内置游戏
 *
 * 契约：docs/API.md（Host API v1）
 */
import { createBuiltin } from './server/builtin.mjs'
import { createRoutes } from './server/http.mjs'
import { createMarket } from './server/market.mjs'
import { dataDir } from './server/paths.mjs'
import { createStore } from './server/store.mjs'

export const name = 'game-bench'

/** 依赖 browser HTTP carrier 服务（Host 组合里由 web-runtime 提供） */
export const inject = ['webServer']

export function apply(ctx) {
  // 统一日志前缀；任何日志都不允许带 token
  const log = (...args) => {
    try {
      console.error('[game-bench]', ...args)
    } catch {
      /* 日志失败忽略 */
    }
  }

  try {
    const builtin = createBuiltin({ log })
    const store = createStore({ log })
    const market = createMarket({ log, store, builtin })
    const routes = createRoutes({ log, builtin, store, market })

    const dispose = ctx.effect(() => {
      const disposers = []
      for (const entry of routes) {
        try {
          disposers.push(ctx.webServer.register(entry))
        } catch (err) {
          // 重复注册等意外情况：只丢这一条路由，不影响插件其余能力
          log('路由注册失败（已跳过）', entry.path, String(err?.message ?? err).slice(0, 120))
        }
      }
      log('激活', `v1.0.0`, `内置 ${builtin.count()} 款`, `数据目录 ${dataDir()}`)
      // 后台预热市场目录：不阻塞激活，失败只记日志（首次打开市场因此不用等网络）
      try {
        Promise.resolve(market.prefetch()).catch((err) => {
          log('目录预热失败（不影响内置游戏）', String(err?.message ?? err).slice(0, 120))
        })
      } catch (err) {
        log('目录预热启动失败（忽略）', String(err?.message ?? err).slice(0, 120))
      }
      return () => {
        for (const off of disposers) {
          try {
            off()
          } catch (err) {
            log('路由释放失败', String(err?.message ?? err).slice(0, 120))
          }
        }
      }
    }, 'game-bench: routes')

    return dispose
  } catch (err) {
    // 激活阶段任何异常都不向外抛，避免把整个 Host 组合拖垮
    log('激活失败（插件保持惰性）', String(err?.message ?? err).slice(0, 200))
    return undefined
  }
}
