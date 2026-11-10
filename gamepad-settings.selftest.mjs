#!/usr/bin/env node
/**
 * dsh-game-bench gamepad-settings.js 自测（Node 内置 node:test，零依赖）
 *
 * 用最小 React 垫片（createElement/useState/useRef/useEffect + 微任务重渲染）与
 * 假 navigator.getGamepads，验证设置组件的真实行为：
 *   - 渲染：空状态、设备名/标准/需校准、当前按键与轴、中英切换、api.t 优先
 *   - 配置：swapAB、deadzone clamp、Joy-Con 合并开关、删除配置
 *   - 校准：完整 8 键流程写入 profile.bindings、轴→方向、重复输入拒绝、ESC 取消不保存、
 *     断连取消、校准前 baseline（初始非 0 轴）不误认、回中后才接受下一步
 *   - 生命周期：卸载清 interval / 移除 ESC 监听、卸载时未完成的校准不落盘
 *
 * 运行：node gamepad-settings.selftest.mjs   （退出码 0=全绿 / 1=失败）
 * 说明：纯逻辑/契约测试，不打开真实浏览器；真机手柄与视觉样式由 QA 集成验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STEPS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT']
const XBOX_STD = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'
const SETTLE_MS = 140 // 略大于组件 100ms 轮询
const DEVICE_KEY = 'xbox wireless controller'

// ---------------------------------------------------------------------------
// 浏览器垫片
// ---------------------------------------------------------------------------
globalThis.window = globalThis

const windowListeners = new Map()
globalThis.addEventListener = (type, handler) => {
  const set = windowListeners.get(type) || new Set()
  set.add(handler)
  windowListeners.set(type, set)
}
globalThis.removeEventListener = (type, handler) => {
  const set = windowListeners.get(type)
  if (set) set.delete(handler)
}
function dispatchWindowKey(key) {
  const set = windowListeners.get('keydown')
  if (!set) return
  const event = { key, preventDefault() {}, stopPropagation() {} }
  Array.from(set).forEach((handler) => handler(event))
}

let currentPads = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    getGamepads: () => currentPads,
  },
})

// 按 <script> 顺序加载：先 gamepads.js（identify/key），再设置组件
new Function(readFileSync(join(HERE, 'gamepads.js'), 'utf8') + '\n//# sourceURL=gamepads.js')()
new Function(readFileSync(join(HERE, 'gamepad-settings.js'), 'utf8') + '\n//# sourceURL=gamepad-settings.js')()

const Gamepads = globalThis.window.GameBenchGamepads
const Settings = globalThis.window.GameBenchGamepadSettings

// ---------------------------------------------------------------------------
// 最小 React 垫片（只覆盖本组件用到的 hooks）
// ---------------------------------------------------------------------------
let renderingContext = null

function createFakeReact() {
  const React = { Fragment: Symbol('Fragment') }

  React.createElement = function (type, props) {
    const flat = []
    const push = (child) => {
      if (Array.isArray(child)) {
        child.forEach(push)
        return
      }
      if (child === null || child === undefined || child === false || child === true) return
      flat.push(child)
    }
    for (let i = 2; i < arguments.length; i += 1) push(arguments[i])
    const merged = Object.assign({}, props || {})
    merged.children = flat
    return { type, props: merged }
  }

  React.useState = function (initial) {
    const context = renderingContext
    const index = context.index++
    if (!(index in context.hooks)) {
      context.hooks[index] = typeof initial === 'function' ? initial() : initial
    }
    const owner = context.owner
    const setState = (next) => {
      const previous = owner.hooks[index]
      const value = typeof next === 'function' ? next(previous) : next
      if (Object.is(value, previous)) return
      owner.hooks[index] = value
      owner.schedule()
    }
    return [owner.hooks[index], setState]
  }

  React.useRef = function (initial) {
    const context = renderingContext
    const index = context.index++
    if (!(index in context.hooks)) context.hooks[index] = { current: initial }
    return context.hooks[index]
  }

  React.useEffect = function (effect, deps) {
    const context = renderingContext
    const index = context.index++
    const previous = context.hooks[index]
    const changed =
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((value, position) => value !== previous.deps[position])
    if (!previous) context.hooks[index] = { deps: deps ? deps.slice() : null, cleanup: null }
    else context.hooks[index].deps = deps ? deps.slice() : null
    if (changed) context.pendingEffects.push({ index, effect })
  }

  return React
}

function createRoot(React, Component) {
  const instance = {
    hooks: [],
    tree: null,
    dirty: false,
    scheduled: false,
    destroyed: false,
  }

  function render() {
    instance.dirty = false
    const context = { hooks: instance.hooks, index: 0, owner: instance, pendingEffects: [] }
    const previous = renderingContext
    renderingContext = context
    let tree = null
    try {
      tree = Component()
    } finally {
      renderingContext = previous
    }
    context.pendingEffects.forEach((entry) => {
      const hook = instance.hooks[entry.index]
      if (hook.cleanup) {
        try {
          hook.cleanup()
        } catch {
          /* ignore */
        }
      }
      let cleanup = null
      try {
        cleanup = entry.effect()
      } catch {
        cleanup = null
      }
      hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    })
    instance.tree = tree
  }

  instance.schedule = () => {
    if (instance.destroyed || instance.dirty) return
    instance.dirty = true
    if (instance.scheduled) return
    instance.scheduled = true
    queueMicrotask(() => {
      instance.scheduled = false
      if (instance.destroyed || !instance.dirty) return
      render()
    })
  }

  instance.mount = () => render()
  instance.unmount = () => {
    instance.destroyed = true
    instance.hooks.forEach((hook) => {
      if (hook && hook.cleanup) {
        try {
          hook.cleanup()
        } catch {
          /* ignore */
        }
        hook.cleanup = null
      }
    })
    instance.tree = null
  }
  return instance
}

function mountSettings(api) {
  const React = createFakeReact()
  const Component = Settings.create(React, api)
  const root = createRoot(React, Component)
  root.mount()
  return root
}

// ---------------------------------------------------------------------------
// 树遍历 / 操作工具
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function walk(node, visit) {
  if (!node) return
  if (typeof node === 'string') {
    visit(node)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
}

function findAll(tree, predicate) {
  const out = []
  walk(tree, (node) => {
    if (node && typeof node === 'object' && predicate(node)) out.push(node)
  })
  return out
}

function findOne(tree, predicate) {
  return findAll(tree, predicate)[0] || null
}

function byData(root, prop, value) {
  return findOne(root.tree, (node) => {
    if (!node.props || node.props[prop] === undefined) return false
    if (value === undefined) return true
    return node.props[prop] === value
  })
}

function textOf(root) {
  let text = ''
  walk(root.tree, (node) => {
    if (typeof node === 'string') text += node + ' '
  })
  return text
}

function click(root, prop, value) {
  const node = byData(root, prop, value)
  assert.ok(node, '找不到可点击元素 ' + prop + '=' + String(value))
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} })
}

function changeInput(root, prop, value, nextValue) {
  const node = byData(root, prop, value)
  assert.ok(node, '找不到输入元素 ' + prop + '=' + String(value))
  node.props.onChange({ target: { value: String(nextValue), checked: true } })
}

async function waitFor(predicate, timeout = 2500, label = 'condition') {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return true
    await sleep(20)
  }
  throw new Error('等待超时：' + label)
}

// ---------------------------------------------------------------------------
// 假 Gamepad / 假 api
// ---------------------------------------------------------------------------
function makePad({ id = XBOX_STD, mapping = 'standard', index = 0, buttons = {}, axes = [0, 0, 0, 0] } = {}) {
  const maxButton = Object.keys(buttons).reduce((max, key) => Math.max(max, Number(key)), -1)
  const list = []
  for (let i = 0; i <= Math.max(maxButton, 15); i += 1) {
    const value = buttons[i]
    if (value === undefined) list.push({ pressed: false, value: 0 })
    else if (typeof value === 'number') list.push({ pressed: value > 0.5, value })
    else list.push({ pressed: true, value: 1 })
  }
  return { id, mapping, index, connected: true, buttons: list, axes: axes.slice() }
}

function setPressed(pad, buttonIndex, pressed) {
  while (pad.buttons.length <= buttonIndex) pad.buttons.push({ pressed: false, value: 0 })
  pad.buttons[buttonIndex] = pressed ? { pressed: true, value: 1 } : { pressed: false, value: 0 }
}

function setAxis(pad, axisIndex, value) {
  while (pad.axes.length <= axisIndex) pad.axes.push(0)
  pad.axes[axisIndex] = value
}

function makeApi(options = {}) {
  const state = {
    profiles: options.profiles || {},
    paired: !!options.paired,
    locale: options.locale || 'zh',
    dictionary: options.dictionary || null,
    saves: 0,
    pairedWrites: 0,
  }
  const api = {
    getProfiles() {
      return state.profiles
    },
    saveProfiles(next) {
      state.profiles = next
      state.saves += 1
    },
    getPaired() {
      return state.paired
    },
    setPaired(value) {
      state.paired = !!value
      state.pairedWrites += 1
    },
  }
  Object.defineProperty(api, 'locale', {
    get() {
      return state.locale
    },
  })
  Object.defineProperty(api, 't', {
    get() {
      if (!state.dictionary) return undefined
      return (key) => state.dictionary[key] || ''
    },
  })
  return { api, state }
}

// 供校准测试复用：挂载 → 点校准 → 依次输入 → 等落盘
async function runCalibration(root, pad, plan, state) {
  click(root, 'data-gb-pad-calibrate', DEVICE_KEY)
  await waitFor(() => textOf(root).includes('请按 UP'), 2500, '等待校准第一步 UP')
  for (let i = 0; i < plan.length; i += 1) {
    const input = plan[i]
    if (input.button !== undefined) setPressed(pad, input.button, true)
    else setAxis(pad, input.axis, input.value)

    if (i < plan.length - 1) {
      await waitFor(() => textOf(root).includes('松开所有按键'), 2500, `第 ${i + 1} 步捕获`)
      if (input.button !== undefined) setPressed(pad, input.button, false)
      else setAxis(pad, input.axis, 0)
      await waitFor(() => textOf(root).includes('请按 ' + STEPS[i + 1]), 2500, `等待第 ${i + 2} 步`)
    } else {
      await waitFor(
        () => !!(state.profiles[DEVICE_KEY] && state.profiles[DEVICE_KEY].bindings),
        2500,
        '等待校准落盘',
      )
    }
  }
  await sleep(SETTLE_MS)
}

// ---------------------------------------------------------------------------
// 1. 基础渲染
// ---------------------------------------------------------------------------
test('渲染：无手柄空状态 + 提示配对需在系统设置完成', async () => {
  currentPads = []
  const { api } = makeApi()
  const root = mountSettings(api)
  try {
    await sleep(SETTLE_MS)
    const text = textOf(root)
    assert.ok(text.includes('手柄'))
    assert.ok(text.includes('未检测到手柄'))
    assert.ok(text.includes('系统设置'))
    assert.ok(byData(root, 'data-gb-gamepad-settings') !== null)
    assert.ok(byData(root, 'data-gb-switch', 'gb-merge-joycon') !== null)
  } finally {
    root.unmount()
  }
})

test('渲染：设备名/标准映射/当前按键与轴，中英内置文案切换', async () => {
  const pad = makePad({ buttons: { 0: true }, axes: [0, 0.6, 0, 0] })
  currentPads = [pad]
  const { api, state } = makeApi()
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备名')
    let text = textOf(root)
    assert.ok(text.includes('标准映射'))
    assert.ok(text.includes('B0'), '展示按下的 button 索引')
    assert.ok(text.includes('A1 0.60'), '展示轴数值')
    state.locale = 'en'
    await waitFor(() => textOf(root).includes('Gamepads'), 2500, '英文文案')
    text = textOf(root)
    assert.ok(text.includes('Standard mapping'))
    assert.ok(text.includes('Current input'))
  } finally {
    root.unmount()
  }
})

test('渲染：api.t 字典优先于内置文案', async () => {
  currentPads = []
  const { api } = makeApi({ dictionary: { 'gp.title': 'CUSTOM-TITLE', 'gp.noPads': 'CUSTOM-NONE' } })
  const root = mountSettings(api)
  try {
    await sleep(SETTLE_MS)
    const text = textOf(root)
    assert.ok(text.includes('CUSTOM-TITLE'))
    assert.ok(text.includes('CUSTOM-NONE'))
  } finally {
    root.unmount()
  }
})

test('渲染：手柄模块缺失时给出提示不抛错', async () => {
  currentPads = []
  const savedModule = globalThis.window.GameBenchGamepads
  delete globalThis.window.GameBenchGamepads
  const { api } = makeApi()
  let root = null
  try {
    root = mountSettings(api)
    await sleep(SETTLE_MS)
    assert.ok(textOf(root).includes('手柄模块未加载'))
  } finally {
    if (root) root.unmount()
    globalThis.window.GameBenchGamepads = savedModule
  }
})

// ---------------------------------------------------------------------------
// 2. 配置读写
// ---------------------------------------------------------------------------
test('配置：swapAB / deadzone（含 clamp）/ 删除配置', async () => {
  currentPads = [makePad()]
  const { api, state } = makeApi({
    profiles: { [DEVICE_KEY]: { swapAB: false, deadZone: 0.5, bindings: { A: { button: 0 } } } },
  })
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    // swapAB：false → true
    click(root, 'data-gb-switch', 'gb-swap-ab-0')
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY].swapAB, true)
    // deadzone：0.7 保存；0.1 clamp 到 0.25；0.95 clamp 到 0.8
    changeInput(root, 'data-gb-pad-deadzone', DEVICE_KEY, 0.7)
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY].deadZone, 0.7)
    changeInput(root, 'data-gb-pad-deadzone', DEVICE_KEY, 0.1)
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY].deadZone, 0.25)
    changeInput(root, 'data-gb-pad-deadzone', DEVICE_KEY, 0.95)
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY].deadZone, 0.8)
    // 删除配置：移除整个 key
    click(root, 'data-gb-pad-reset', DEVICE_KEY)
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY], undefined)
  } finally {
    root.unmount()
  }
})

test('配置：Joy-Con 合并开关读写 api.getPaired/setPaired', async () => {
  currentPads = [makePad()]
  const { api, state } = makeApi({ paired: false })
  const root = mountSettings(api)
  try {
    await sleep(SETTLE_MS)
    const switchNode = byData(root, 'data-gb-switch', 'gb-merge-joycon')
    assert.ok(switchNode)
    assert.equal(switchNode.props['aria-checked'], false)
    click(root, 'data-gb-switch', 'gb-merge-joycon')
    await sleep(SETTLE_MS)
    assert.equal(state.paired, true)
    assert.equal(state.pairedWrites, 1)
    const updated = byData(root, 'data-gb-switch', 'gb-merge-joycon')
    assert.equal(updated.props['aria-checked'], true)
    click(root, 'data-gb-switch', 'gb-merge-joycon')
    await sleep(SETTLE_MS)
    assert.equal(state.paired, false)
  } finally {
    root.unmount()
  }
})

test('配置：live getter（外部改 profiles/locale 后轮询自动反映，不缓存初值）', async () => {
  currentPads = [makePad()]
  const { api, state } = makeApi({ profiles: { [DEVICE_KEY]: { swapAB: false } } })
  const root = mountSettings(api)
  try {
    await sleep(SETTLE_MS)
    assert.equal(byData(root, 'data-gb-switch', 'gb-swap-ab-0').props['aria-checked'], false)
    state.profiles = { [DEVICE_KEY]: { swapAB: true } }
    state.locale = 'en'
    await waitFor(
      () =>
        byData(root, 'data-gb-switch', 'gb-swap-ab-0').props['aria-checked'] === true &&
        textOf(root).includes('Gamepads'),
      2500,
      '外部状态更新',
    )
  } finally {
    root.unmount()
  }
})

// ---------------------------------------------------------------------------
// 3. 校准
// ---------------------------------------------------------------------------
test('校准：完整 8 步按键流程写入 profile.bindings，且每步要回中', async () => {
  const pad = makePad()
  currentPads = [pad]
  const { api, state } = makeApi()
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    const plan = [
      { button: 12 },
      { button: 13 },
      { button: 14 },
      { button: 15 },
      { button: 0 },
      { button: 1 },
      { button: 9 },
      { button: 8 },
    ]
    await runCalibration(root, pad, plan, state)
    assert.ok(state.profiles[DEVICE_KEY], '应写入设备 profile')
    assert.deepEqual(state.profiles[DEVICE_KEY].bindings, {
      UP: { button: 12 },
      DOWN: { button: 13 },
      LEFT: { button: 14 },
      RIGHT: { button: 15 },
      A: { button: 0 },
      B: { button: 1 },
      START: { button: 9 },
      SELECT: { button: 8 },
    })
    // 完成后校准 UI 消失
    assert.equal(byData(root, 'data-gb-calibrating'), null)
  } finally {
    root.unmount()
  }
})

test('校准：摇杆方向记录为 {axis,direction}（轴→方向）', async () => {
  const pad = makePad()
  currentPads = [pad]
  const { api, state } = makeApi()
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    const plan = [
      { axis: 1, value: -0.9 }, // UP
      { axis: 1, value: 0.9 }, // DOWN
      { axis: 0, value: -0.9 }, // LEFT
      { axis: 0, value: 0.9 }, // RIGHT
      { button: 0 },
      { button: 1 },
      { button: 9 },
      { button: 8 },
    ]
    await runCalibration(root, pad, plan, state)
    const bindings = state.profiles[DEVICE_KEY].bindings
    assert.deepEqual(bindings.UP, { axis: 1, direction: -1 })
    assert.deepEqual(bindings.DOWN, { axis: 1, direction: 1 })
    assert.deepEqual(bindings.LEFT, { axis: 0, direction: -1 })
    assert.deepEqual(bindings.RIGHT, { axis: 0, direction: 1 })
    assert.deepEqual(bindings.A, { button: 0 })
  } finally {
    root.unmount()
  }
})

test('校准：baseline 记录初始非 0 轴，未回到 baseline 不当作输入', async () => {
  // 进入校准时 hat 轴停在 -0.9；不回中前不应被识别为按下
  const pad = makePad({ axes: [0, -0.9, 0, 0] })
  currentPads = [pad]
  const { api, state } = makeApi()
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    click(root, 'data-gb-pad-calibrate', DEVICE_KEY)
    await waitFor(() => textOf(root).includes('请按 UP'), 2500, '等待 armed')
    await sleep(300)
    // 未改变轴/未按键：不能推进到 DOWN
    assert.ok(!textOf(root).includes('请按 DOWN'))
    // 从 baseline 移动 1.8（到 +0.9）视为 DOWN 方向输入
    setAxis(pad, 1, 0.9)
    await waitFor(() => textOf(root).includes('松开所有按键'), 2500, '轴输入被捕获')
    setAxis(pad, 1, -0.9) // 回到 baseline
    await waitFor(() => textOf(root).includes('请按 DOWN') || textOf(root).includes('请按 LEFT'), 2500, '回到 baseline 后继续')
    dispatchWindowKey('Escape')
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY], undefined)
  } finally {
    root.unmount()
  }
})

test('校准：重复输入被拒绝（提示已用于哪一步）且不推进', async () => {
  const pad = makePad()
  currentPads = [pad]
  const { api, state } = makeApi()
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    click(root, 'data-gb-pad-calibrate', DEVICE_KEY)
    await waitFor(() => textOf(root).includes('请按 UP'), 2500, '等待 UP')

    // UP = button0
    setPressed(pad, 0, true)
    await waitFor(() => textOf(root).includes('松开所有按键'), 2500, 'UP 捕获')
    setPressed(pad, 0, false)
    await waitFor(() => textOf(root).includes('请按 DOWN'), 2500, '等待 DOWN')

    // DOWN 再按同一个 button0 → 拒绝
    setPressed(pad, 0, true)
    await waitFor(() => textOf(root).includes('已用于 UP'), 2500, '重复提示')
    setPressed(pad, 0, false)
    // 释放并回中后仍在 DOWN 步，换 button13 才继续
    await waitFor(() => textOf(root).includes('请按 DOWN'), 2500, '重试 DOWN')
    setPressed(pad, 13, true)
    await waitFor(() => textOf(root).includes('松开所有按键'), 2500, 'DOWN 捕获')
    setPressed(pad, 13, false)
    // 取消，不保存半成品
    dispatchWindowKey('Escape')
    await sleep(SETTLE_MS)
    assert.equal(state.profiles[DEVICE_KEY], undefined)
    assert.equal(state.saves, 0)
    assert.equal(byData(root, 'data-gb-calibrating'), null)
  } finally {
    root.unmount()
  }
})

test('校准：ESC 取消不保存半成品；断连自动取消且不保存', async () => {
  const pad = makePad()
  currentPads = [pad]
  const { api, state } = makeApi()
  const root = mountSettings(api)
  try {
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    // ESC
    click(root, 'data-gb-pad-calibrate', DEVICE_KEY)
    await waitFor(() => textOf(root).includes('请按 UP'), 2500, '等待 UP')
    dispatchWindowKey('Escape')
    await sleep(SETTLE_MS)
    assert.equal(byData(root, 'data-gb-calibrating'), null)
    assert.equal(state.profiles[DEVICE_KEY], undefined)
    assert.ok(textOf(root).includes('已取消校准'))

    // 断连
    click(root, 'data-gb-pad-calibrate', DEVICE_KEY)
    await waitFor(() => textOf(root).includes('请按 UP'), 2500, '再次等待 UP')
    currentPads = []
    await waitFor(() => textOf(root).includes('手柄已断开'), 2500, '断连提示')
    assert.equal(byData(root, 'data-gb-calibrating'), null)
    assert.equal(state.profiles[DEVICE_KEY], undefined)
    assert.equal(state.saves, 0)
  } finally {
    currentPads = []
    root.unmount()
  }
})

// ---------------------------------------------------------------------------
// 4. 生命周期
// ---------------------------------------------------------------------------
test('生命周期：卸载清理 interval / ESC 监听，未完成的校准不落盘', async () => {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const activeIntervals = new Set()
  globalThis.setInterval = (fn, ms) => {
    const id = originalSetInterval(fn, ms)
    activeIntervals.add(id)
    return id
  }
  globalThis.clearInterval = (id) => {
    activeIntervals.delete(id)
    return originalClearInterval(id)
  }

  const pad = makePad()
  currentPads = [pad]
  const { api, state } = makeApi()
  let root = null
  try {
    root = mountSettings(api)
    await waitFor(() => textOf(root).includes('Xbox Wireless Controller'), 2500, '设备面板')
    assert.equal(activeIntervals.size, 1, '挂载后应有 1 个轮询 interval')

    click(root, 'data-gb-pad-calibrate', DEVICE_KEY)
    await waitFor(() => textOf(root).includes('请按 UP'), 2500, '等待 UP')
    assert.ok(windowListeners.get('keydown') && windowListeners.get('keydown').size > 0)

    root.unmount()
    assert.equal(activeIntervals.size, 0, '卸载后 interval 已清理')
    assert.equal(windowListeners.get('keydown') ? windowListeners.get('keydown').size : 0, 0, 'ESC 监听已移除')
    assert.equal(state.profiles[DEVICE_KEY], undefined, '卸载不保存半成品')

    // 卸载后继续改手柄状态不应有任何写入/异常
    currentPads = [makePad({ buttons: { 0: true } })]
    await sleep(250)
    assert.equal(state.saves, 0)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    if (root) {
      try {
        root.unmount()
      } catch {
        /* ignore */
      }
    }
    currentPads = []
  }
})
