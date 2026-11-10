#!/usr/bin/env node
/**
 * 拾光游戏厅 · 真实 Host 接口验收（不需要 DSH Web 鉴权 URL）
 *
 * 直接打**已安装到真实 desktop profile 的插件路由**（DSH Web GUI 同源）：
 *   GET  /game-bench/api/status         → ok、builtinCount、vendor.jsnes/engine
 *   GET  /game-bench/api/library        → 内置游戏卡片字段
 *   GET  /game-bench/api/rom/<id>       → 真实字节 + SHA-256 与 games/builtin.json 一致
 *   GET  /game-bench/api/cover/<id>     → 200 + PNG
 *   GET  /game-bench/api/vendor/jsnes.js、/engine.js → 200 + 引擎版本标记
 *   GET  /game-bench/api/market         → 目录（首次预热给 90s；上游不可用 → SKIP 并打印原始响应）
 *   POST /game-bench/api/install        → 真实下载 + SHA 校验（市场不可用时 SKIP）
 *   POST /game-bench/api/uninstall      → 清理并回滚（幂等）
 *
 * 注意：install/uninstall 会写真实数据目录（`/status.dataDir`），脚本保证 finally 清理；
 * 只安装 1 款小游戏，测试后卸载并断言 /library 回到安装前状态。
 *
 * 用法：node real-api.mjs                       （优先 DSH_WEB_URL，其次 GB_HOST_URL）
 *       GB_HOST_URL=http://127.0.0.1:60333 node real-api.mjs
 * 退出码：0 无 FAIL（允许 SKIP）/ 1 有 FAIL / 2 插件路由不可达（未安装或未激活）
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const BASE = (process.env.GB_HOST_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:61254').replace(/\/+$/, '')
const API = `${BASE}/game-bench/api`
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const passed = []
const failed = []
const skipped = []
const check = (label, ok, extra) => {
  if (ok) { passed.push(label); console.log(`  ✓ ${label}${extra === undefined ? '' : ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})`}`) }
  else { failed.push({ label, extra }); console.log(`  ✗ ${label}${extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`) }
}
const skip = (label, why) => { skipped.push({ label, why }); console.log(`  ~ SKIP ${label} → ${why}`) }
const brief = (v, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > n ? s.slice(0, n) + '…' : s
}
const section = (name) => console.log(`\n${name}`)

async function req(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const init = { method, signal: AbortSignal.timeout(timeoutMs), headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${API}${path}`, init)
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  const type = res.headers.get('content-type') || ''
  if (/json/i.test(type)) { try { json = JSON.parse(buf.toString('utf8')) } catch { /* ignore */ } }
  return { status: res.status, type, buf, json, headers: res.headers }
}

/* ------------------------------------------------------------------ */
console.log(`拾光游戏厅 · 真实 Host 接口验收  ${API}\n`)

/* [0] 路由可达性（未安装时 exit 2，不算 FAIL） */
section('[0] 真实环境可达性')
let status0
try {
  status0 = await req('/status', { timeoutMs: 10000 })
} catch (err) {
  console.error(`[BLOCKED] 连不上真实插件路由：${brief(String(err && err.message))}`)
  console.error('  → 确认 DSH Web GUI 在运行、游戏厅插件已安装并激活（plugin_manager list_plugins 查看）。')
  process.exit(2)
}
if (status0.status !== 200 || !status0.json || status0.json.ok !== true) {
  console.error(`[BLOCKED] /status 未返回成功信封：HTTP ${status0.status} ${brief(status0.buf.toString('utf8').slice(0, 300))}`)
  console.error('  → 可能是插件未安装 / webServer 未注册路由；退出码 2（不当作 FAIL）。')
  process.exit(2)
}
console.log(`  · dataDir = ${status0.json.data.dataDir}`)

/* [1] /status */
section('[1] GET /status')
const st = status0.json.data
check('/status HTTP 200 + {ok:true}', status0.status === 200 && status0.json.ok === true)
check('builtinCount ≥ 1（public demo + 本机 local 合并后的数量）', Number(st.builtinCount) >= 1, st.builtinCount)
check('installedCount 为数字', typeof st.installedCount === 'number', st.installedCount)
check('vendor.jsnes = true', st.vendor && st.vendor.jsnes === true, st.vendor)
check('vendor.engine = true', st.vendor && st.vendor.engine === true, st.vendor)
check('version 字段存在', !!st.version, st.version)
const marketStatus = st.market || {}
console.log(`  · market: auth=${marketStatus.auth} ready=${marketStatus.ready} catalogGames=${marketStatus.catalogGames} error=${brief(marketStatus.error, 120)}`)

/* [2] /library */
section('[2] GET /library')
const lib = await req('/library')
const library = (lib.json && lib.json.data) || {}
const games = Array.isArray(library.games) ? library.games : []
check('/library HTTP 200 + {ok:true}', lib.status === 200 && !!lib.json && lib.json.ok === true)
check('内置游戏 ≥ 7 张', games.filter((g) => g.builtin).length >= 7, games.length)
check('每张卡有 id / title / cover', games.length > 0 && games.every((g) => g && g.id && g.title && g.cover), brief(games.slice(0, 2)))
check('内置游戏 installed = true', games.filter((g) => g.builtin).every((g) => g.installed === true))
const builtinGames = games.filter((g) => g.builtin)
const headerCache = lib.headers.get('cache-control')
check('/library 响应带 Cache-Control: no-store', /no-store/i.test(headerCache || ''), headerCache)

/* [3] 内置 ROM 字节 + SHA 与 builtin.json 一致 */
section('[3] GET /rom/<内置 id>（真实字节 + SHA）')
/* Host 内置清单 = public builtin.json（可分发 demo）+ games/builtin.local.json（本机私有，gitignore）合并 */
const byId = new Map()
for (const file of ['builtin.json', 'builtin.local.json']) {
  const p = join(PLUGIN, 'games', file)
  if (!existsSync(p)) continue
  const doc = JSON.parse(readFileSync(p, 'utf8'))
  for (const g of doc.games || []) byId.set(g.id, g)
}
let romOk = 0
let romChecked = 0
for (const game of builtinGames) {
  const expected = byId.get(game.id)
  const rom = await req(`/rom/${game.id}`)
  romChecked += 1
  const expectedSha = expected ? expected.sha256 : String(game.id).replace(/^nes-/, '')
  const actualSha = sha256(rom.buf)
  const ok = rom.status === 200 && rom.buf.length > 1024 && actualSha === expectedSha
  if (ok) romOk += 1
  else check(`ROM ${game.title} 字节 >1024 且 SHA-256 匹配`, false, { status: rom.status, size: rom.buf.length, actualSha: actualSha.slice(0, 12), expected: String(expectedSha).slice(0, 12) })
}
check(`内置 ROM 全部 200、字节 >1024、SHA-256 与 manifest 一致（${romOk}/${romChecked}）`, romChecked >= 1 && romOk === romChecked)
check('ROM Content-Type = application/octet-stream', (await req(`/rom/${builtinGames[0].id}`)).type.includes('application/octet-stream'))

/* [4] 封面 */
section('[4] GET /cover/<id>（真实 PNG）')
let coverOk = 0
for (const game of builtinGames) {
  const cover = await req(`/cover/${game.id}`)
  const isPng = cover.buf.length > 100 && cover.buf[0] === 0x89 && cover.buf[1] === 0x50 && cover.buf[2] === 0x4e && cover.buf[3] === 0x47
  if (cover.status === 200 && isPng) coverOk += 1
  else check(`封面 ${game.title} 200 + PNG 魔数`, false, { status: cover.status, type: cover.type, size: cover.buf.length })
}
check(`内置封面全部 200 且为真实 PNG（${coverOk}/${builtinGames.length}）`, builtinGames.length >= 1 && coverOk === builtinGames.length)

/* [5] 运行时文件 */
section('[5] GET /vendor/jsnes.js、/engine.js')
const jsnes = await req('/vendor/jsnes.js')
check('vendor/jsnes.js 200 + JS 内容（UMD）', jsnes.status === 200 && jsnes.buf.length > 1000 && /function|define|exports/.test(jsnes.buf.toString('utf8').slice(0, 500)), jsnes.buf.length)
const engine = await req('/engine.js')
const engineText = engine.buf.toString('utf8')
check('engine.js 200 + 含 __GAME_BENCH_ENGINE_VERSION__', engine.status === 200 && engineText.includes('__GAME_BENCH_ENGINE_VERSION__'), engine.buf.length)
check('engine.js 暴露 window.GameBenchCore', /GameBenchCore/.test(engineText))
const engineVer = await req('/engine.js').then(() => (engineText.match(/ENGINE_VERSION\s*=\s*'([^']+)'/) || [])[1] || null)
console.log(`  · engine version = ${engineVer}`)

/* 手柄运行时模块（client.loadPadModules 必需；Host 必须提供这两条静态路由） */
const pads = await req('/gamepads.js')
const padsText = pads.buf.toString('utf8')
check('GET /gamepads.js 200 + JS（GameBenchGamepads / assign/decode）',
  pads.status === 200 && pads.buf.length > 1000 && /GameBenchGamepads/.test(padsText) && /assign/.test(padsText),
  { status: pads.status, size: pads.buf.length })
const padSettings = await req('/gamepad-settings.js')
const padSettingsText = padSettings.buf.toString('utf8')
check('GET /gamepad-settings.js 200 + JS（GameBenchGamepadSettings.create）',
  padSettings.status === 200 && padSettings.buf.length > 1000 && /GameBenchGamepadSettings/.test(padSettingsText),
  { status: padSettings.status, size: padSettings.buf.length })
if (st.vendor && (st.vendor.gamepads !== undefined || st.vendor.gamepadSettings !== undefined)) {
  check('/status.vendor 含手柄模块状态（gamepads / gamepadSettings）',
    st.vendor.gamepads === true && st.vendor.gamepadSettings === true, st.vendor)
} else {
  console.log('  · /status.vendor 尚未包含 gamepads 字段（运行中的 Host 是旧激活版本，重装后可断言）')
}

/* [6] 市场（真实 GitHub；首次预热可能 90s） */
section('[6] GET /market（真实目录，首次可能预热）')
let market = null
let marketItems = []
try {
  const t0 = Date.now()
  const res = await req('/market', { timeoutMs: 90000 })
  console.log(`  · /market HTTP ${res.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (res.status === 200 && res.json && res.json.ok === true) {
    market = res.json.data
    marketItems = (market.featured || []).slice()
    for (const col of market.collections || []) marketItems = marketItems.concat(col.games || [])
    const seen = new Set()
    marketItems = marketItems.filter((g) => g && g.id && !seen.has(g.id) && seen.add(g.id))
    check('/market 返回 {ok:true}', true)
    check('total > 1000（真实资源库 1131 款）', Number(market.total) > 1000, market.total)
    check('collections ≥ 5', Array.isArray(market.collections) && market.collections.length >= 5, (market.collections || []).map((c) => `${c.id}:${c.total}`))
    check('featured ≥ 8', Array.isArray(market.featured) && market.featured.length >= 8, (market.featured || []).length)
    const probe = marketItems[0]
    if (probe) {
      const c = await req(`/cover/${probe.id}`)
      check('市场封面懒加载：GET /cover/<市场 id> 200 + PNG', c.status === 200 && c.buf[0] === 0x89 && c.buf[1] === 0x50, { id: probe.id, status: c.status, size: c.buf.length })
    }
  } else {
    const raw = res.json || res.buf.toString('utf8')
    skip('GET /market 目录', `上游/传输层不可用：HTTP ${res.status} ${brief(raw, 240)}`)
  }
} catch (err) {
  skip('GET /market 目录', `超时/网络错误：${brief(String(err && err.message), 200)}`)
}

/* [7] 安装 → SHA 校验 → 卸载清理 */
section('[7] POST /install → /rom SHA 校验 → POST /uninstall（真实下载与回滚）')
if (!marketItems.length) {
  skip('安装/卸载真实市场游戏', '市场目录不可用，无法选款（先修复 Host 传输层或预热后重跑）')
} else {
  const beforeCount = (await req('/library')).json.data.games.length
  const beforeInstalled = (await req('/status')).json.data.installedCount
  // 选一款小的（资源库里 坦克/90坦克 这类 <100KB；优先标题含坦克）
  const candidates = marketItems.filter((g) => !g.installed && g.id)
  const pick = candidates.find((g) => /坦克/.test(g.title)) || candidates[0]
  console.log(`  · 目标：${pick.title} (${pick.id})`)
  let installedNow = false
  try {
    const ins = await req('/install', { method: 'POST', body: { id: pick.id }, timeoutMs: 120000 })
    const insJson = ins.json || {}
    check('/install 返回 {ok:true, data.game}', ins.status === 200 && insJson.ok === true && !!(insJson.data && insJson.data.game), brief(insJson, 240))
    installedNow = !!(insJson.ok && insJson.data && insJson.data.game)
    const romBytes = await req(`/rom/${pick.id}`, { timeoutMs: 60000 })
    const expectSha = pick.sha256 || String(pick.id).replace(/^nes-/, '')
    const actual = sha256(romBytes.buf)
    check('安装后 /rom 字节 SHA-256 与目录 sha256 一致（校验通过）', romBytes.status === 200 && actual === expectSha, { size: romBytes.buf.length, actual: actual.slice(0, 12), expect: String(expectSha).slice(0, 12) })
    const afterLib = await req('/library')
    const afterGames = afterLib.json.data.games
    check('/library 出现已安装游戏（builtin:false, installed:true）', afterGames.some((g) => g.id === pick.id && g.installed === true && g.builtin === false), afterGames.filter((g) => g.id === pick.id))
    const afterStatus = await req('/status')
    check('/status installedCount +1', afterStatus.json.data.installedCount === beforeInstalled + 1, { before: beforeInstalled, after: afterStatus.json.data.installedCount })
    // 幂等
    const again = await req('/install', { method: 'POST', body: { id: pick.id }, timeoutMs: 60000 })
    check('重复 /install 幂等（仍 ok:true）', again.status === 200 && again.json && again.json.ok === true, brief(again.json, 160))
  } catch (err) {
    check('/install 真实下载（失败详情见上）', false, brief(String(err && err.message), 240))
  } finally {
    if (installedNow) {
      const un = await req('/uninstall', { method: 'POST', body: { id: pick.id }, timeoutMs: 30000 }).catch((e) => ({ status: 0, json: { ok: false, error: String(e && e.message) } }))
      check('/uninstall 返回 removed:true', un.status === 200 && un.json && un.json.ok === true && un.json.data && un.json.data.removed === true, brief(un.json, 240))
      const libAfter = await req('/library')
      const gamesAfter = libAfter.json.data.games
      check('卸载后 /library 回到安装前数量', gamesAfter.length === beforeCount, { before: beforeCount, after: gamesAfter.length })
      check('卸载后 /library 不再含该游戏', !gamesAfter.some((g) => g.id === pick.id))
      const romAfter = await req(`/rom/${pick.id}`)
      check('卸载后 /rom/<id> → 404（文件已删）', romAfter.status === 404, romAfter.status)
      const statusAfter = await req('/status')
      check('卸载后 installedCount 回滚', statusAfter.json.data.installedCount === beforeInstalled, { before: beforeInstalled, after: statusAfter.json.data.installedCount })
      // 二次卸载幂等
      const un2 = await req('/uninstall', { method: 'POST', body: { id: pick.id }, timeoutMs: 30000 })
      check('重复 /uninstall 幂等（不报错）', un2.status === 200 && un2.json && un2.json.ok === true, brief(un2.json, 160))
    } else {
      // 失败也保证清理：尝试 uninstall（可能未安装，幂等）
      await req('/uninstall', { method: 'POST', body: { id: pick.id }, timeoutMs: 30000 }).catch(() => {})
    }
  }
}

/* [8] 收尾 */
section('[8] 收尾健康检查')
try {
  const finalStatus = await req('/status')
  check('最终 /status 仍 200 且 ok:true', finalStatus.status === 200 && finalStatus.json.ok === true)
  const finalLib = await req('/library')
  check('最终 /library 内置游戏数量与 /status 一致', finalLib.json.data.games.filter((g) => g.builtin).length === finalStatus.json.data.builtinCount, finalLib.json.data.games.filter((g) => g.builtin).length)
} catch (err) {
  check('最终健康检查', false, String(err && err.message))
}

console.log('\n================ 真实 Host 接口验收结果 ================')
console.log(`PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length}`)
if (failed.length) {
  console.log('\nFAIL 清单：')
  for (const f of failed) console.log(`  ✗ ${f.label}${f.extra === undefined ? '' : ` → ${typeof f.extra === 'string' ? f.extra : JSON.stringify(f.extra)}`}`)
}
if (skipped.length) {
  console.log('\nSKIP 清单（上游不可用，不算 FAIL）：')
  for (const s of skipped) console.log(`  ~ ${s.label} → ${s.why}`)
}
console.log(`\n目标：${API}`)
process.exit(failed.length ? 1 : 0)
