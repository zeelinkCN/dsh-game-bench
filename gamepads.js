/**
 * 拾光游戏厅 — 手柄输入适配层（gamepads.js）
 *
 * 自包含 IIFE，只在 window 上暴露 window.GameBenchGamepads，供 client 的手柄轮询 /
 * Settings 校准 UI 使用。不监听任何事件、不改 DOM、无网络、无存储副作用；
 * 输入暂停 / 失焦 / 按键清理由 client 负责（本模块只做无状态的解码）。
 *
 * ── API ────────────────────────────────────────────────────────────────────
 *   decode(pad, profile) -> Set<'A'|'B'|'UP'|'DOWN'|'LEFT'|'RIGHT'|'START'|'SELECT'>
 *       把一帧 Gamepad 快照解码成 NES 按键集合。
 *   identify(pad) -> { name, nintendo, side, standard, needsMapping }
 *       name: 去掉浏览器后缀的可读名；nintendo: 是否任天堂设备；
 *       side: Joy-Con 单只的 'left'|'right'，其余 null；standard: 浏览器标准映射；
 *       needsMapping: 非标准映射的任天堂手柄（必须提示校准，且 decode 默认返回空集）。
 *   key(pad) -> string
 *       稳定的设备配置键（同型号手柄跨连接/映射一致；左右 Joy-Con 不同）。
 *   assign(pads, paired = true) -> [{ pad, player: 1|2 }]
 *       玩家分配。paired 时：已识别的 Joy-Con L + R 合并为 1P（两个条目 player=1），
 *       其余第一个控制器为 2P；没有可配对时，按 pad.index 顺序前两台分别为 1P / 2P。
 *
 * ── profile ────────────────────────────────────────────────────────────────
 *   {
 *     deadZone: 0.25..0.8,            // 摇杆死区，默认 0.45（沿用旧 client 行为）
 *     swapAB:   boolean,              // A/B 互换（任天堂布局手柄常用）
 *     bindings: {                     // 自定义按键（自定义优先于默认映射）
 *       A:     { button: 0 },         // 按下 buttons[0]
 *       B:     { button: 1 },
 *       UP:    { axis: 1, direction: -1 },  // axis=1 且值 <= -deadZone 时按下
 *       DOWN:  { axis: 1, direction:  1 },
 *       LEFT:  { axis: 0, direction: -1 },
 *       RIGHT: { axis: 0, direction:  1 },
 *       START: { button: 9 },
 *       SELECT:{ button: 8 },
 *     },
 *   }
 *   bindings 里未指定的按键回退到默认映射（标准映射 / 旧版默认映射）；
 *   非法 binding 条目会被忽略并回退。swapAB 在最终结果上交换 A/B。
 *
 * ── 默认映射（与既有 client.js PAD_BUTTONS 完全一致）──────────────────────
 *   A=button0, B=button1, SELECT=button8, START=button9,
 *   UP/DOWN/LEFT/RIGHT = button12/13/14/15，或左摇杆 axes[1]/axes[0] 超死区。
 *   标准映射（pad.mapping === 'standard'）与“未知非标准手柄”都走这套默认映射；
 *   **非标准映射的任天堂手柄不猜测原始按键**，默认 decode 返回空集（needsMapping）。
 *
 * ── 边界与已知限制 ─────────────────────────────────────────────────────────
 *   - 只消费 Web Gamepad API（navigator.getGamepads()）暴露的快照；蓝牙 / USB 传输
 *     由浏览器统一暴露，本模块不区分。
 *   - 系统或浏览器不可见的设备无法读取；不实现 WebHID 原生协议，不承诺旧 Wii 手柄
 *     （需要额外驱动 / 蓝牙配对）。
 *   - **未用真实任天堂手柄实测**：标准映射遵循 W3C Gamepad 规范；设备识别基于常见
 *     id（Vendor: 057e、Product: 2006/2007/2009…）与名称关键字，不同浏览器/系统
 *     的 id 写法可能不同，届时应走自定义校准。
 *   - 单只 Joy-Con 的“横握方向”无法从 Gamepad API 得知；标准映射下按键/摇杆按浏览器
 *     上报的轴解码，方向不顺手时用 profile.bindings 校准。
 *   - 不提供震动 / 体感 / 截图键；不解析 Home、Capture 等 NES 用不到的按键。
 */
;(function () {
  'use strict'

  var root =
    typeof window !== 'undefined' && window
      ? window
      : typeof globalThis !== 'undefined'
        ? globalThis
        : null
  if (!root) return

  var VERSION = '1.0.0'
  root.__GAME_BENCH_GAMEPADS_VERSION__ = VERSION

  var BUTTONS = ['A', 'B', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'SELECT']
  var DEFAULT_DEAD_ZONE = 0.45 // 与旧 client 的 ±0.45 轴阈值一致
  var MIN_DEAD_ZONE = 0.25
  var MAX_DEAD_ZONE = 0.8

  // 与 client.js 既有 PAD_BUTTONS 一致：A=0, B=1, SELECT=8, START=9, 方向=12..15
  var DEFAULT_BINDINGS = {
    A: [{ button: 0 }],
    B: [{ button: 1 }],
    SELECT: [{ button: 8 }],
    START: [{ button: 9 }],
    UP: [{ button: 12 }, { axis: 1, direction: -1 }],
    DOWN: [{ button: 13 }, { axis: 1, direction: 1 }],
    LEFT: [{ button: 14 }, { axis: 0, direction: -1 }],
    RIGHT: [{ button: 15 }, { axis: 0, direction: 1 }],
  }

  // 任天堂设备常见的 USB Vendor（Switch 系列统一为 057e）。
  var NINTENDO_VENDOR = 0x057e
  // 常见 Product: 2006=Joy-Con(L), 2007=Joy-Con(R), 2009=Pro Controller,
  // 200e/200f=充电握把/组合, 2017=SNES 风格手柄（均按“无单只 side”处理）。
  var NINTENDO_PRODUCTS = {
    0x2006: 'left',
    0x2007: 'right',
    0x2009: null,
    0x200e: null,
    0x200f: null,
    0x2017: null,
  }

  var VENDOR_RE = /vendor:\s*([0-9a-f]{4})/i
  var PRODUCT_RE = /product:\s*([0-9a-f]{4})/i
  var NINTENDO_NAME_RE = /nintendo|switch|joy-?con|pro controller/i
  var BROWSER_SUFFIX_RE = /\((?:standard gamepad|vendor)[^)]*\)/gi

  function padId(pad) {
    return pad && typeof pad.id === 'string' ? pad.id : ''
  }

  function parseHexField(id, regex) {
    var match = regex.exec(id)
    return match ? parseInt(match[1], 16) : null
  }

  // 去掉浏览器追加的 "(STANDARD GAMEPAD Vendor: … Product: …)" / "(Vendor: …)" 后缀。
  function cleanName(id) {
    if (!id) return ''
    var name = String(id)
    // 后缀可能连续出现多次（不同浏览器拼法不同），最多清 3 轮
    for (var i = 0; i < 3; i++) {
      var next = name.replace(BROWSER_SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim()
      if (next === name) break
      name = next
    }
    return name
  }

  function detectSide(lowerId, product) {
    if (product === 0x2006) return 'left'
    if (product === 0x2007) return 'right'
    // 组合形态（L/R 同体、握把）不当作单只
    if (/joy-?con[^)]*l\s*\/\s*r/.test(lowerId)) return null
    if (/joy-?con[^)]*\(\s*l\s*\)/.test(lowerId)) return 'left'
    if (/joy-?con[^)]*\(\s*r\s*\)/.test(lowerId)) return 'right'
    if (/joy-?con.*\bleft\b/.test(lowerId)) return 'left'
    if (/joy-?con.*\bright\b/.test(lowerId)) return 'right'
    if (/\bjoy-?con\s+l\b/.test(lowerId)) return 'left'
    if (/\bjoy-?con\s+r\b/.test(lowerId)) return 'right'
    return null
  }

  // identify 结果按 (id, mapping) 缓存：轮询每帧都会调用，避免重复正则。
  var identifyCache = new Map()
  var IDENTIFY_CACHE_LIMIT = 64

  function classify(id, mapping) {
    var cacheKey = id + '|' + mapping
    var cached = identifyCache.get(cacheKey)
    if (cached) return cached

    var lowerId = id.toLowerCase()
    var vendor = parseHexField(id, VENDOR_RE)
    var product = parseHexField(id, PRODUCT_RE)
    var nintendo =
      vendor === NINTENDO_VENDOR ||
      NINTENDO_NAME_RE.test(lowerId) ||
      (product !== null && Object.prototype.hasOwnProperty.call(NINTENDO_PRODUCTS, product))
    var standard = mapping === 'standard'
    var side = nintendo ? detectSide(lowerId, product) : null
    var cleaned = cleanName(id)
    var info = {
      // 无 id 的伪快照（测试/异常输入）返回空名；有 id 但被浏览器后缀清空时兜底 Gamepad
      name: cleaned || (id ? 'Gamepad' : ''),
      nintendo: !!nintendo,
      side: side,
      standard: standard,
      needsMapping: !!nintendo && !standard,
    }

    identifyCache.set(cacheKey, info)
    if (identifyCache.size > IDENTIFY_CACHE_LIMIT) {
      var oldest = identifyCache.keys().next()
      if (!oldest.done) identifyCache.delete(oldest.value)
    }
    return info
  }

  function identify(pad) {
    if (!pad) {
      return { name: '', nintendo: false, side: null, standard: false, needsMapping: false }
    }
    var mapping = typeof pad.mapping === 'string' ? pad.mapping.toLowerCase() : ''
    var info = classify(padId(pad), mapping)
    // 返回副本，避免调用方改动缓存对象
    return {
      name: info.name,
      nintendo: info.nintendo,
      side: info.side,
      standard: info.standard,
      needsMapping: info.needsMapping,
    }
  }

  function key(pad) {
    if (!pad) return ''
    var id = padId(pad).trim()
    if (!id) return ''
    var name = cleanName(id) || id
    var normalized = name.toLowerCase().replace(/\s+/g, ' ').trim()
    return normalized
  }

  // ---- profile 归一化 ------------------------------------------------------

  function clampDeadZone(value) {
    if (typeof value !== 'number' || !isFinite(value)) return DEFAULT_DEAD_ZONE
    if (value < MIN_DEAD_ZONE) return MIN_DEAD_ZONE
    if (value > MAX_DEAD_ZONE) return MAX_DEAD_ZONE
    return value
  }

  function sanitizeBinding(value) {
    if (!value || typeof value !== 'object') return null
    var button = value.button
    if (
      typeof button === 'number' &&
      isFinite(button) &&
      button >= 0 &&
      Math.floor(button) === button
    ) {
      return { button: button }
    }
    var axis = value.axis
    var direction = value.direction
    if (
      typeof axis === 'number' &&
      isFinite(axis) &&
      axis >= 0 &&
      Math.floor(axis) === axis &&
      (direction === 1 || direction === -1)
    ) {
      return { axis: axis, direction: direction }
    }
    return null
  }

  function normalizeProfile(profile) {
    var swapAB = false
    var deadZone = DEFAULT_DEAD_ZONE
    var bindings = null
    if (profile && typeof profile === 'object') {
      if (profile.swapAB === true) swapAB = true
      if (typeof profile.deadZone === 'number') deadZone = clampDeadZone(profile.deadZone)
      var raw = profile.bindings
      if (raw && typeof raw === 'object') {
        var result = {}
        for (var i = 0; i < BUTTONS.length; i++) {
          var name = BUTTONS[i]
          var value = raw[name]
          if (value === undefined) value = raw[name.toLowerCase()]
          var binding = sanitizeBinding(value)
          if (binding) result[name] = binding
        }
        bindings = result
      }
    }
    return { swapAB: swapAB, deadZone: deadZone, bindings: bindings }
  }

  // ---- 读取 Gamepad 快照 ---------------------------------------------------

  function isButtonPressed(pad, index) {
    var buttons = pad && pad.buttons
    if (!buttons || typeof buttons.length !== 'number') return false
    if (index < 0 || index >= buttons.length) return false
    var button = buttons[index]
    if (typeof button === 'number') return button > 0.5
    if (!button) return false
    if (button.pressed === true) return true
    var value = typeof button.value === 'number' ? button.value : 0
    return value > 0.5
  }

  function axisValue(pad, index) {
    var axes = pad && pad.axes
    if (!axes || typeof axes.length !== 'number') return 0
    if (index < 0 || index >= axes.length) return 0
    var value = axes[index]
    return typeof value === 'number' && isFinite(value) ? value : 0
  }

  function isAxisPressed(pad, index, direction, deadZone) {
    var value = axisValue(pad, index)
    if (direction > 0) return value >= deadZone
    return value <= -deadZone
  }

  function bindingPressed(pad, binding, deadZone) {
    if (!binding) return false
    if (typeof binding.button === 'number') return isButtonPressed(pad, binding.button)
    if (typeof binding.axis === 'number') {
      return isAxisPressed(pad, binding.axis, binding.direction, deadZone)
    }
    return false
  }

  function anyPressed(pad, bindings, deadZone) {
    for (var i = 0; i < bindings.length; i++) {
      if (bindingPressed(pad, bindings[i], deadZone)) return true
    }
    return false
  }

  function swapAB(set) {
    var hasA = set.has('A')
    var hasB = set.has('B')
    if (hasA === hasB) return
    if (hasA) {
      set.delete('A')
      set.add('B')
    } else {
      set.delete('B')
      set.add('A')
    }
  }

  // ---- decode --------------------------------------------------------------

  function decode(pad, profile) {
    var result = new Set()
    if (!pad) return result

    var info = identify(pad)
    var normalized = normalizeProfile(profile)
    var custom = normalized.bindings
    // 标准映射，或“未知的非任天堂非标准手柄”沿用旧默认映射；
    // 非标准映射的任天堂手柄不猜测原始按键（needsMapping），除非有自定义 bindings。
    var allowDefaults = info.standard || !info.nintendo

    for (var i = 0; i < BUTTONS.length; i++) {
      var name = BUTTONS[i]
      var hasCustom = custom !== null && Object.prototype.hasOwnProperty.call(custom, name)
      if (hasCustom) {
        // 自定义优先：该按键只认自定义 binding，不再叠加默认映射
        if (bindingPressed(pad, custom[name], normalized.deadZone)) result.add(name)
        continue
      }
      if (!allowDefaults) continue
      if (anyPressed(pad, DEFAULT_BINDINGS[name], normalized.deadZone)) result.add(name)
    }

    if (normalized.swapAB) swapAB(result)
    return result
  }

  // ---- assign --------------------------------------------------------------

  function usablePad(pad) {
    return !!pad && pad.connected !== false
  }

  function padIndex(pad) {
    return pad && typeof pad.index === 'number' && isFinite(pad.index)
      ? pad.index
      : Number.MAX_SAFE_INTEGER
  }

  function assign(pads, paired) {
    var list = []
    if (pads && typeof pads.length === 'number') {
      for (var i = 0; i < pads.length; i++) {
        if (usablePad(pads[i])) list.push(pads[i])
      }
    }
    // 稳定排序：先按 pad.index，再按传入顺序，保证同一帧内分配确定
    var decorated = list.map(function (pad, position) {
      return { pad: pad, position: position, index: padIndex(pad) }
    })
    decorated.sort(function (a, b) {
      if (a.index !== b.index) return a.index - b.index
      return a.position - b.position
    })

    var result = []
    var used = []

    if (paired !== false) {
      var left = null
      var right = null
      for (var j = 0; j < decorated.length; j++) {
        var info = identify(decorated[j].pad)
        if (info.side === 'left' && !left) left = decorated[j].pad
        else if (info.side === 'right' && !right) right = decorated[j].pad
      }
      if (left && right) {
        // 左右 Joy-Con 合并为 1P：返回两个条目，client 取并集后 setButton(player=1)
        result.push({ pad: left, player: 1 })
        result.push({ pad: right, player: 1 })
        used.push(left, right)
        for (var k = 0; k < decorated.length; k++) {
          if (used.indexOf(decorated[k].pad) === -1) {
            result.push({ pad: decorated[k].pad, player: 2 })
            break
          }
        }
        return result
      }
    }

    var player = 0
    for (var m = 0; m < decorated.length; m++) {
      if (used.indexOf(decorated[m].pad) !== -1) continue
      if (player >= 2) break
      player += 1
      result.push({ pad: decorated[m].pad, player: player })
    }
    return result
  }

  root.GameBenchGamepads = {
    BUTTONS: BUTTONS.slice(),
    DEFAULT_DEAD_ZONE: DEFAULT_DEAD_ZONE,
    MIN_DEAD_ZONE: MIN_DEAD_ZONE,
    MAX_DEAD_ZONE: MAX_DEAD_ZONE,
    decode: decode,
    identify: identify,
    key: key,
    assign: assign,
  }
})()
