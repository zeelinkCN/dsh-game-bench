#!/usr/bin/env node
/**
 * dsh-game-bench gamepads.js 自测（Node 内置 node:test + node:assert，零依赖）
 *
 * 运行：
 *   node gamepads.selftest.mjs          # 直接执行，退出码 0=全绿 / 1=有失败
 *
 * 覆盖：
 *   - identify：标准/未标准、Switch Pro、Joy-Con L/R、组合形态、设备名清洗、缓存隔离
 *   - key：同型号稳定、左右 Joy-Con 区分、空设备安全
 *   - decode：标准映射、旧版默认映射（与 client.js PAD_BUTTONS 一致）、非标准任天堂
 *             不猜按键、自定义 bindings 优先/回退、轴/死区/边界/clamp、swapAB
 *   - assign：Joy-Con L+R 合 1P、无配对顺序 1/2、单台 1P、paired=false、断连/null/
 *             数组形态输入、按 index 稳定排序、不修改入参、多组配对
 *
 * 说明：以上全部基于构造的 Gamepad 快照（W3C Gamepad API 形状），**未使用真实手柄**；
 * 真机行为取决于浏览器/系统实现，详见 gamepads.js 头部“边界与已知限制”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// 浏览器外执行：提供最小 window 垫片，再按 <script> 方式执行 IIFE
globalThis.window = globalThis
new Function(readFileSync(join(HERE, 'gamepads.js'), 'utf8') + '\n//# sourceURL=gamepads.js')()
const G = globalThis.window.GameBenchGamepads

// ---------------------------------------------------------------------------
// 构造 Gamepad 快照的测试工具
// ---------------------------------------------------------------------------
const IDS = {
  xboxStd: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  ps5Std: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
  proStd: 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)',
  proRaw: 'Pro Controller (Vendor: 057e Product: 2009)',
  joyLStd: 'Joy-Con (L) (STANDARD GAMEPAD Vendor: 057e Product: 2006)',
  joyRStd: 'Joy-Con (R) (STANDARD GAMEPAD Vendor: 057e Product: 2007)',
  joyLRaw: 'Joy-Con (L) (Vendor: 057e Product: 2006)',
  joyRRaw: 'Joy-Con (R) (Vendor: 057e Product: 2007)',
  joyCombined: 'Joy-Con (L/R) (Vendor: 057e Product: 200e)',
  genericRaw: 'Generic USB Gamepad',
  genericStd: 'Generic USB Gamepad (STANDARD GAMEPAD Vendor: 1234 Product: 5678)',
}

/**
 * buttons: { index: true | value }，生成到最大 index 的按钮数组。
 * axes: 数值数组（默认 4 轴全 0）。
 */
function makePad(options = {}) {
  const {
    id = IDS.genericRaw,
    mapping = '',
    buttons = {},
    axes = [0, 0, 0, 0],
    index = 0,
    connected = true,
  } = options
  const maxButton = Object.keys(buttons).reduce((max, key) => Math.max(max, Number(key)), -1)
  const buttonList = []
  for (let i = 0; i <= maxButton; i += 1) {
    const value = buttons[i]
    if (value === undefined) buttonList.push({ pressed: false, value: 0 })
    else if (typeof value === 'number') buttonList.push({ pressed: value > 0.5, value })
    else buttonList.push({ pressed: true, value: 1 })
  }
  return {
    id,
    mapping,
    buttons: buttonList,
    axes: axes.slice(),
    index,
    connected,
  }
}

function namesOf(set) {
  return Array.from(set).sort()
}

function expectSet(set, expected) {
  assert.ok(set instanceof Set, 'decode 必须返回 Set')
  assert.deepEqual(namesOf(set), expected.slice().sort())
}

// ---------------------------------------------------------------------------
// 1. 模块契约
// ---------------------------------------------------------------------------
test('模块加载：暴露 decode/identify/key/assign 与常量，版本号 1.0.0', () => {
  assert.ok(G && typeof G === 'object')
  assert.equal(typeof G.decode, 'function')
  assert.equal(typeof G.identify, 'function')
  assert.equal(typeof G.key, 'function')
  assert.equal(typeof G.assign, 'function')
  assert.deepEqual(G.BUTTONS, ['A', 'B', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT'])
  assert.equal(G.DEFAULT_DEAD_ZONE, 0.45)
  assert.equal(G.MIN_DEAD_ZONE, 0.25)
  assert.equal(G.MAX_DEAD_ZONE, 0.8)
  assert.equal(globalThis.__GAME_BENCH_GAMEPADS_VERSION__, '1.0.0')
})

// ---------------------------------------------------------------------------
// 2. identify
// ---------------------------------------------------------------------------
test('identify：标准 Xbox / DualSense 非任天堂、无需校准', () => {
  for (const id of [IDS.xboxStd, IDS.ps5Std]) {
    const info = G.identify(makePad({ id, mapping: 'standard' }))
    assert.equal(info.nintendo, false, id)
    assert.equal(info.standard, true, id)
    assert.equal(info.needsMapping, false, id)
    assert.equal(info.side, null, id)
  }
  assert.equal(G.identify(makePad({ id: IDS.xboxStd, mapping: 'standard' })).name, 'Xbox Wireless Controller')
})

test('identify：标准映射 Switch Pro 走浏览器标准按键，不要求校准', () => {
  const info = G.identify(makePad({ id: IDS.proStd, mapping: 'standard' }))
  assert.equal(info.nintendo, true)
  assert.equal(info.standard, true)
  assert.equal(info.needsMapping, false)
  assert.equal(info.side, null)
  assert.equal(info.name, 'Pro Controller')
})

test('identify：标准映射 Joy-Con (L)/(R) 识别 side，且无需校准', () => {
  const left = G.identify(makePad({ id: IDS.joyLStd, mapping: 'standard' }))
  assert.equal(left.nintendo, true)
  assert.equal(left.side, 'left')
  assert.equal(left.standard, true)
  assert.equal(left.needsMapping, false)
  assert.equal(left.name, 'Joy-Con (L)')

  const right = G.identify(makePad({ id: IDS.joyRStd, mapping: 'standard' }))
  assert.equal(right.side, 'right')
  assert.equal(right.name, 'Joy-Con (R)')
})

test('identify：仅凭 Vendor 057e / Product 2006 也能识别 Joy-Con 侧别', () => {
  const left = G.identify(makePad({ id: 'Wireless Gamepad (STANDARD GAMEPAD Vendor: 057e Product: 2006)' }))
  assert.equal(left.nintendo, true)
  assert.equal(left.side, 'left')
  const right = G.identify(makePad({ id: 'Wireless Gamepad (Product: 2007 Vendor: 057e)' }))
  assert.equal(right.side, 'right')
})

test('identify：Joy-Con 组合形态 (L/R) 不当作单只', () => {
  const info = G.identify(makePad({ id: IDS.joyCombined, mapping: 'standard' }))
  assert.equal(info.nintendo, true)
  assert.equal(info.side, null)
  // L/R 合并体没有单只 side；标准映射下正常解码
  assert.equal(info.needsMapping, false)
})

test('identify：非标准映射的任天堂手柄 needsMapping=true（必须提示校准）', () => {
  const info = G.identify(makePad({ id: IDS.joyLRaw, mapping: '' }))
  assert.equal(info.nintendo, true)
  assert.equal(info.standard, false)
  assert.equal(info.needsMapping, true)
  assert.equal(info.side, 'left')
  assert.equal(info.name, 'Joy-Con (L)')

  const pro = G.identify(makePad({ id: IDS.proRaw, mapping: '' }))
  assert.equal(pro.nintendo, true)
  assert.equal(pro.needsMapping, true)
})

test('identify：未知非标准手柄不算 Nintendo，needsMapping=false（沿用旧默认映射）', () => {
  const info = G.identify(makePad({ id: IDS.genericRaw, mapping: '' }))
  assert.equal(info.nintendo, false)
  assert.equal(info.standard, false)
  assert.equal(info.needsMapping, false)
  assert.equal(info.side, null)
  assert.equal(info.name, 'Generic USB Gamepad')
})

test('identify：null/缺字段不抛错，返回安全默认值', () => {
  for (const bad of [null, undefined, {}, { id: '' }, { id: 123 }]) {
    const info = G.identify(bad)
    assert.deepEqual(info, {
      name: '',
      nintendo: false,
      side: null,
      standard: false,
      needsMapping: false,
    })
  }
})

test('identify：缓存按 (id, mapping) 隔离，不串味', () => {
  const std = G.identify(makePad({ id: IDS.proRaw, mapping: 'standard' }))
  const raw = G.identify(makePad({ id: IDS.proRaw, mapping: '' }))
  assert.equal(std.standard, true)
  assert.equal(std.needsMapping, false)
  assert.equal(raw.standard, false)
  assert.equal(raw.needsMapping, true)
})

// ---------------------------------------------------------------------------
// 3. key
// ---------------------------------------------------------------------------
test('key：同型号在有/无浏览器后缀时得到同一个稳定键', () => {
  const withSuffix = G.key(makePad({ id: IDS.proStd, mapping: 'standard' }))
  const withoutSuffix = G.key(makePad({ id: 'Pro Controller', mapping: '' }))
  assert.equal(withSuffix, 'pro controller')
  assert.equal(withoutSuffix, 'pro controller')
  assert.equal(G.key(makePad({ id: '  Xbox   Wireless Controller  ' })), 'xbox wireless controller')
})

test('key：左右 Joy-Con 键不同，Joy-Con 与 Pro Controller 不同', () => {
  const left = G.key(makePad({ id: IDS.joyLStd, mapping: 'standard' }))
  const right = G.key(makePad({ id: IDS.joyRStd, mapping: 'standard' }))
  assert.equal(left, 'joy-con (l)')
  assert.equal(right, 'joy-con (r)')
  assert.notEqual(left, right)
  assert.notEqual(left, G.key(makePad({ id: IDS.proStd, mapping: 'standard' })))
})

test('key：空设备返回空字符串', () => {
  assert.equal(G.key(null), '')
  assert.equal(G.key(undefined), '')
  assert.equal(G.key({}), '')
  assert.equal(G.key({ id: '   ' }), '')
})

// ---------------------------------------------------------------------------
// 4. decode：默认映射（与 client.js PAD_BUTTONS 一致）
// ---------------------------------------------------------------------------
test('decode：标准映射手柄按 W3C 标准按键/左摇杆解码（A=0, B=1, START=9, SELECT=8, 方向=12..15）', () => {
  const pad = makePad({
    id: IDS.xboxStd,
    mapping: 'standard',
    buttons: { 0: true, 1: true, 8: true, 9: true, 12: true, 13: true, 14: true, 15: true },
    axes: [0, 0, 0, 0],
  })
  expectSet(G.decode(pad), ['A', 'B', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT'])
})

test('decode：标准手柄的左摇杆超死区产生方向键', () => {
  const pad = makePad({ id: IDS.xboxStd, mapping: 'standard', axes: [-0.6, 0.6, 0, 0] })
  expectSet(G.decode(pad), ['LEFT', 'DOWN'])
})

test('decode：未知非标准手柄沿用旧版默认映射（含摇杆轴）', () => {
  const pad = makePad({
    id: IDS.genericRaw,
    mapping: '',
    buttons: { 0: true, 1: true, 8: true, 9: true, 12: true, 13: true, 14: true, 15: true },
    axes: [-0.5, 0.5, 0, 0],
  })
  expectSet(G.decode(pad), ['A', 'B', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT'])
})

test('decode：默认死区 0.45，恰好等于阈值也算按下', () => {
  expectSet(G.decode(makePad({ id: IDS.xboxStd, mapping: 'standard', axes: [0, 0.45, 0, 0] })), ['DOWN'])
  expectSet(G.decode(makePad({ id: IDS.xboxStd, mapping: 'standard', axes: [0, 0.449, 0, 0] })), [])
  expectSet(G.decode(makePad({ id: IDS.xboxStd, mapping: 'standard', axes: [0, -0.45, 0, 0] })), ['UP'])
})

test('decode：数值型按钮（0..1）按 >0.5 判定', () => {
  const pad = makePad({ id: IDS.genericRaw, mapping: '' })
  pad.buttons = [0.9, 0.4]
  expectSet(G.decode(pad), ['A'])
})

test('decode：缺 buttons/axes 字段不抛错，返回空集', () => {
  expectSet(G.decode({ id: IDS.genericRaw, mapping: '' }), [])
  expectSet(G.decode({}), [])
  expectSet(G.decode(null), [])
  expectSet(G.decode(undefined), [])
})

test('decode：标准手柄只有摇杆、没有 buttons 时仍能解出方向', () => {
  expectSet(G.decode({ id: IDS.xboxStd, mapping: 'standard', axes: [-0.7, 0.7] }), ['LEFT', 'DOWN'])
})

test('decode：每次返回独立 Set，不复用内部状态', () => {
  const pad = makePad({ id: IDS.xboxStd, mapping: 'standard', buttons: { 0: true } })
  const first = G.decode(pad)
  first.add('START')
  const second = G.decode(pad)
  expectSet(second, ['A'])
  assert.notEqual(first, second)
})

// ---------------------------------------------------------------------------
// 5. decode：swapAB / 死区范围
// ---------------------------------------------------------------------------
test('decode：swapAB 交换 A/B（任天堂布局常用）', () => {
  const aOnly = makePad({ id: IDS.proStd, mapping: 'standard', buttons: { 0: true } })
  expectSet(G.decode(aOnly), ['A'])
  expectSet(G.decode(aOnly, { swapAB: true }), ['B'])

  const bOnly = makePad({ id: IDS.proStd, mapping: 'standard', buttons: { 1: true } })
  expectSet(G.decode(bOnly), ['B'])
  expectSet(G.decode(bOnly, { swapAB: true }), ['A'])

  const both = makePad({ id: IDS.proStd, mapping: 'standard', buttons: { 0: true, 1: true } })
  expectSet(G.decode(both, { swapAB: true }), ['A', 'B'])
})

test('decode：deadZone 可调，且被 clamp 到 0.25..0.8', () => {
  const pad = (value) => makePad({ id: IDS.xboxStd, mapping: 'standard', axes: [value, 0, 0, 0] })
  // 0.8 死区：0.79 不算，0.8 算
  expectSet(G.decode(pad(0.79), { deadZone: 0.8 }), [])
  expectSet(G.decode(pad(0.8), { deadZone: 0.8 }), ['RIGHT'])
  // 低于 0.25 被抬到 0.25
  expectSet(G.decode(pad(0.26), { deadZone: 0.01 }), ['RIGHT'])
  expectSet(G.decode(pad(0.24), { deadZone: 0.01 }), [])
  // 高于 0.8 被压到 0.8
  expectSet(G.decode(pad(0.7), { deadZone: 5 }), [])
})

// ---------------------------------------------------------------------------
// 6. decode：自定义 bindings（优先级 / 回退 / 轴）
// ---------------------------------------------------------------------------
test('decode：自定义 bindings 优先于标准映射（覆盖后不再叠加默认）', () => {
  const pad = makePad({ id: IDS.xboxStd, mapping: 'standard', buttons: { 0: true, 1: true, 2: true } })
  const profile = { bindings: { A: { button: 2 } } }
  // A 只认 button2（按下）；B 未自定义 → 回退标准 button1（按下）；button0 不再产生 A
  expectSet(G.decode(pad, profile), ['A', 'B'])
})

test('decode：自定义只覆盖部分按键，其余回退默认映射', () => {
  const pad = makePad({ id: IDS.xboxStd, mapping: 'standard', buttons: { 0: true, 9: true } })
  const profile = { bindings: { A: { button: 2 } } }
  // A 由 button2 决定（没按）→ 无 A；START 回退默认 → button9；button0 被覆盖，不再产生 A
  expectSet(G.decode(pad, profile), ['START'])
})

test('decode：自定义轴 binding（direction -1/+1）与死区生效', () => {
  const bindings = {
    LEFT: { axis: 0, direction: -1 },
    RIGHT: { axis: 0, direction: 1 },
    UP: { axis: 1, direction: -1 },
    DOWN: { axis: 1, direction: 1 },
  }
  const pad = makePad({ id: IDS.genericRaw, mapping: '', axes: [-0.7, 0.8, 0, 0] })
  expectSet(G.decode(pad, { bindings }), ['LEFT', 'DOWN'])
  // 方向与轴相反的 binding 不触发
  const flipped = makePad({ id: IDS.genericRaw, mapping: '', axes: [0.7, -0.8, 0, 0] })
  expectSet(G.decode(flipped, { bindings }), ['RIGHT', 'UP'])
})

test('decode：非法 binding 被忽略并回退默认映射', () => {
  const pad = makePad({ id: IDS.xboxStd, mapping: 'standard', buttons: { 0: true } })
  const invalid = {
    bindings: {
      A: { button: -1 },
      B: { button: 1.5 },
      UP: { axis: 1, direction: 0 },
      NOPE: { button: 3 },
    },
  }
  expectSet(G.decode(pad, invalid), ['A'])
})

test('decode：bindings 键名大小写均可（A / a）', () => {
  const pad = makePad({ id: IDS.genericRaw, mapping: '', buttons: { 0: true } })
  expectSet(G.decode(pad, { bindings: { a: { button: 0 } } }), ['A'])
  expectSet(G.decode(pad, { bindings: { A: { button: 0 } } }), ['A'])
})

test('decode：非标准任天堂手柄默认不猜原始按键（空集）', () => {
  const pad = makePad({
    id: IDS.joyLRaw,
    mapping: '',
    buttons: { 0: true, 1: true, 8: true, 9: true, 12: true, 13: true, 14: true, 15: true },
    axes: [-0.9, 0.9, 0, 0],
  })
  expectSet(G.decode(pad), [])
})

test('decode：非标准任天堂手柄经 bindings 校准后可正常解码', () => {
  const pad = makePad({
    id: IDS.joyLRaw,
    mapping: '',
    buttons: { 0: true, 1: true, 9: true },
    axes: [-0.8, 0.9, 0, 0],
  })
  const profile = {
    bindings: {
      A: { button: 0 },
      B: { button: 1 },
      START: { button: 9 },
      LEFT: { axis: 0, direction: -1 },
      DOWN: { axis: 1, direction: 1 },
    },
  }
  expectSet(G.decode(pad, profile), ['A', 'B', 'DOWN', 'LEFT', 'START'])
})

test('decode：swapAB 作用在自定义 binding 结果之上', () => {
  const pad = makePad({ id: IDS.joyLRaw, mapping: '', buttons: { 3: true } })
  const profile = { bindings: { A: { button: 3 } }, swapAB: true }
  expectSet(G.decode(pad, profile), ['B'])
})

// ---------------------------------------------------------------------------
// 7. assign：玩家分配
// ---------------------------------------------------------------------------
test('assign：Joy-Con L+R 合并为 1P，另一个控制器为 2P', () => {
  const xbox = makePad({ id: IDS.xboxStd, mapping: 'standard', index: 0 })
  const left = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 1 })
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 2 })
  const assigned = G.assign([xbox, left, right])
  assert.equal(assigned.length, 3)
  assert.deepEqual(
    assigned.map((entry) => entry.player),
    [1, 1, 2],
  )
  const p1 = assigned.filter((entry) => entry.player === 1).map((entry) => entry.pad)
  assert.deepEqual(p1, [left, right])
  assert.equal(assigned[2].pad, xbox)
})

test('assign：配对不受数组顺序影响（按 pad.index 稳定排序）', () => {
  const left = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 1 })
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 2 })
  const xbox = makePad({ id: IDS.xboxStd, mapping: 'standard', index: 0 })
  const assigned = G.assign([right, xbox, left])
  assert.deepEqual(
    assigned.map((entry) => [entry.pad.id, entry.player]),
    [
      [IDS.joyLStd, 1],
      [IDS.joyRStd, 1],
      [IDS.xboxStd, 2],
    ],
  )
})

test('assign：无配对时两台控制器按顺序分 1P/2P，不能只用第一台', () => {
  const first = makePad({ id: IDS.xboxStd, mapping: 'standard', index: 0 })
  const second = makePad({ id: IDS.ps5Std, mapping: 'standard', index: 1 })
  const assigned = G.assign([first, second])
  assert.deepEqual(
    assigned.map((entry) => [entry.pad, entry.player]),
    [
      [first, 1],
      [second, 2],
    ],
  )
  // 按 index 而非数组位置
  const swapped = G.assign([second, first])
  assert.deepEqual(
    swapped.map((entry) => [entry.pad, entry.player]),
    [
      [first, 1],
      [second, 2],
    ],
  )
})

test('assign：单台控制器为 1P', () => {
  const pad = makePad({ id: IDS.xboxStd, mapping: 'standard', index: 3 })
  assert.deepEqual(G.assign([pad]), [{ pad, player: 1 }])
})

test('assign：只有一只 Joy-Con + 另一控制器时不做配对，顺序 1P/2P', () => {
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 0 })
  const xbox = makePad({ id: IDS.xboxStd, mapping: 'standard', index: 1 })
  assert.deepEqual(
    G.assign([right, xbox]).map((entry) => [entry.pad, entry.player]),
    [
      [right, 1],
      [xbox, 2],
    ],
  )
})

test('assign：paired=false 时不做 L/R 合并，按顺序 1P/2P', () => {
  const left = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 0 })
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 1 })
  const xbox = makePad({ id: IDS.xboxStd, mapping: 'standard', index: 2 })
  const assigned = G.assign([left, right, xbox], false)
  assert.deepEqual(
    assigned.map((entry) => [entry.pad, entry.player]),
    [
      [left, 1],
      [right, 2],
    ],
  )
})

test('assign：过滤 null / connected=false，接受类数组（getGamepads 形状）', () => {
  const disconnected = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 0, connected: false })
  const left = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 1 })
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 2 })
  const arrayLike = { 0: disconnected, 1: left, 2: right, length: 3 }
  const assigned = G.assign(arrayLike)
  assert.equal(assigned.length, 2)
  assert.deepEqual(
    assigned.map((entry) => entry.player),
    [1, 1],
  )
  assert.deepEqual(
    assigned.map((entry) => entry.pad),
    [left, right],
  )
})

test('assign：非标准映射的 Joy-Con L/R 也照常配对（校准由 profile 负责）', () => {
  const left = makePad({ id: IDS.joyLRaw, mapping: '', index: 0 })
  const right = makePad({ id: IDS.joyRRaw, mapping: '', index: 1 })
  const assigned = G.assign([left, right])
  assert.deepEqual(
    assigned.map((entry) => [entry.pad, entry.player]),
    [
      [left, 1],
      [right, 1],
    ],
  )
})

test('assign：多组 Joy-Con 时只取第一组配对，其余第一个为 2P', () => {
  const left1 = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 0 })
  const right1 = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 1 })
  const left2 = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 2 })
  const right2 = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 3 })
  const assigned = G.assign([right2, left1, right1, left2])
  assert.deepEqual(
    assigned.map((entry) => [entry.pad, entry.player]),
    [
      [left1, 1],
      [right1, 1],
      [left2, 2],
    ],
  )
})

test('assign：最多两个玩家；第三台无配对手柄被忽略', () => {
  const pads = [0, 1, 2].map((index) =>
    makePad({ id: IDS.xboxStd, mapping: 'standard', index }),
  )
  const assigned = G.assign(pads)
  assert.equal(assigned.length, 2)
  assert.deepEqual(
    assigned.map((entry) => entry.player),
    [1, 2],
  )
})

test('assign：不修改传入数组，空/非法入参返回 []', () => {
  const left = makePad({ id: IDS.joyLStd, mapping: 'standard', index: 1 })
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', index: 2 })
  const input = [right, left]
  const before = input.slice()
  G.assign(input)
  assert.deepEqual(input, before)
  for (const bad of [[], null, undefined, 42, {}]) {
    assert.deepEqual(G.assign(bad), [])
  }
})

// ---------------------------------------------------------------------------
// 8. 与旧 client.js 轮询逻辑的随机对拍（保证未校准手柄行为不变）
// ---------------------------------------------------------------------------
test('decode：未知非标准手柄与旧 PAD_BUTTONS+±0.45 轮询逻辑随机对拍一致', () => {
  const LEGACY = { 0: 'A', 1: 'B', 8: 'SELECT', 9: 'START', 12: 'UP', 13: 'DOWN', 14: 'LEFT', 15: 'RIGHT' }
  function legacyDecode(pad) {
    const set = new Set()
    const buttons = pad.buttons || []
    Object.keys(LEGACY).forEach((index) => {
      const button = buttons[index]
      if (button && (button.pressed || (typeof button.value === 'number' && button.value > 0.5))) {
        set.add(LEGACY[index])
      }
    })
    const axes = pad.axes || []
    if ((axes[0] || 0) < -0.45) set.add('LEFT')
    if ((axes[0] || 0) > 0.45) set.add('RIGHT')
    if ((axes[1] || 0) < -0.45) set.add('UP')
    if ((axes[1] || 0) > 0.45) set.add('DOWN')
    return set
  }

  // 确定性 LCG（不用 Math.random，失败可复现）
  let seed = 123456789
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let round = 0; round < 60; round += 1) {
    const buttons = {}
    for (let index = 0; index < 17; index += 1) if (rand() < 0.2) buttons[index] = true
    const axes = [rand() * 2 - 1, rand() * 2 - 1, 0, 0]
    const pad = makePad({ id: IDS.genericRaw, mapping: '', buttons, axes })
    assert.deepEqual(namesOf(G.decode(pad)), namesOf(legacyDecode(pad)), `round ${round}`)
  }
})

// ---------------------------------------------------------------------------
// 9. 组合用法：左右 Joy-Con 并集即 1P 完整 NES 按键
// ---------------------------------------------------------------------------
test('组合用法：左右 Joy-Con 解码并集可覆盖 NES 方向 + A/START', () => {
  const left = makePad({ id: IDS.joyLStd, mapping: 'standard', axes: [-0.8, 0, 0, 0] })
  const right = makePad({ id: IDS.joyRStd, mapping: 'standard', buttons: { 0: true, 9: true } })
  const union = new Set([...G.decode(left), ...G.decode(right)])
  expectSet(union, ['A', 'LEFT', 'START'])
})
