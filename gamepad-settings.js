/**
 * 拾光游戏厅 — 手柄设置面板（gamepad-settings.js）
 *
 * 自包含 IIFE，只暴露 window.GameBenchGamepadSettings.create(React, api) → React 组件。
 * 不监听持久事件（除校准期间临时监听 ESC）、无网络、无存储；配置完全交给 api 持久化。
 *
 * ── api（由 Host/client 注入，必须是 live getter/方法，不要在组件里缓存初值）──
 *   api.getProfiles() -> { [deviceKey]: profile }
 *   api.saveProfiles(obj)                 // 整体替换 profiles
 *   api.getPaired() -> boolean            // Joy-Con L/R 是否合并为 1P
 *   api.setPaired(bool)
 *   api.locale -> 'zh' | 'en' ...         // 可选；本组件另带中英两套内置字符串
 *   api.t(key) -> string                  // 可选；优先使用（Host 字典），否则用内置
 *
 * profile 结构（与 gamepads.js 的 decode 约定一致）：
 *   { swapAB?: boolean, deadZone?: number, bindings?: {
 *       UP:    { button: 12 } | { axis: 1, direction: -1 },
 *       DOWN:  { button: 13 } | { axis: 1, direction: 1 },
 *       LEFT:  { button: 14 } | { axis: 0, direction: -1 },
 *       RIGHT: { button: 15 } | { axis: 0, direction: 1 },
 *       A: { button: 0 }, B: { button: 1 },
 *       START: { button: 9 }, SELECT: { button: 8 },
 *   } }
 *
 * 行为：
 *   - 每 100 ms 轮询 navigator.getGamepads()，展示识别名/标准映射或需校准/当前按键与轴；
 *   - Swap A/B、死区 0.25–0.8、Joy-Con 合并开关（读写 api）；
 *   - 每设备一键校准：依次 UP DOWN LEFT RIGHT A B START SELECT，按键或摇杆方向均可；
 *     每步要求先「全部松开且摇杆回到校准前 baseline」再接受下一输入；校准前记录 baseline，
 *     避免初始非 0 轴（hat）被误认；未移动的轴与已用过的输入会被排除；
 *     ESC / 按钮取消，未完成不写入；断连自动取消；删除配置即删除该设备 profile。
 *   - 配对/合并的物理操作需先在系统设置里完成（面板内只有合并开关）。
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
  root.__GAME_BENCH_GAMEPAD_SETTINGS_VERSION__ = VERSION

  var STEPS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT']
  var POLL_MS = 100
  var AXIS_TRIGGER = 0.7 // 校准：轴相对 baseline 变化超过该阈值才认定为方向输入
  var NEUTRAL_TOLERANCE = 0.15 // 校准：轴回到 baseline ± 该容差视为回中
  var DEFAULT_DEAD_ZONE = 0.45
  var MIN_DEAD_ZONE = 0.25
  var MAX_DEAD_ZONE = 0.8
  var DEAD_ZONE_STEP = 0.05

  var hasOwn = Object.prototype.hasOwnProperty

  // 中文 / English 内置文案；api.t(key) 可用时优先（Host 字典）。
  var STRINGS = {
    zh: {
      'gp.title': '手柄',
      'gp.pairHint': 'Joy-Con 左右配对/合并需先在系统设置中完成。',
      'gp.merge': '左右 Joy-Con 合并为 1P',
      'gp.noPads': '未检测到手柄，连接后会自动出现。',
      'gp.needModule': '手柄模块未加载，无法识别设备。',
      'gp.standard': '标准映射',
      'gp.needsCalibration': '需校准',
      'gp.calibrated': '已校准',
      'gp.left': '左手',
      'gp.right': '右手',
      'gp.input': '当前输入',
      'gp.none': '无',
      'gp.swapAB': 'Swap A/B（A/B 互换）',
      'gp.deadZone': '摇杆死区',
      'gp.calibrate': '校准',
      'gp.cancel': '取消校准',
      'gp.reset': '重置映射',
      'gp.calibrating': '校准中',
      'gp.pressInput': '请按 {step}（按键或摇杆方向）',
      'gp.releaseNeutral': '松开所有按键，摇杆回中…',
      'gp.duplicate': '该输入已用于 {name}，请换一个',
      'gp.done': '校准完成，已保存',
      'gp.deleted': '已删除该设备配置',
      'gp.cancelled': '已取消校准（未保存）',
      'gp.disconnected': '手柄已断开，校准已取消',
      'gp.unnamed': '未命名手柄',
      'gp.progress': '{i}/{n}',
    },
    en: {
      'gp.title': 'Gamepads',
      'gp.pairHint': 'Pair or combine Joy-Con in the system settings first.',
      'gp.merge': 'Merge left/right Joy-Con as Player 1',
      'gp.noPads': 'No gamepads detected — they appear automatically once connected.',
      'gp.needModule': 'Gamepad module not loaded — device detection unavailable.',
      'gp.standard': 'Standard mapping',
      'gp.needsCalibration': 'Needs calibration',
      'gp.calibrated': 'Calibrated',
      'gp.left': 'Left',
      'gp.right': 'Right',
      'gp.input': 'Current input',
      'gp.none': 'None',
      'gp.swapAB': 'Swap A/B',
      'gp.deadZone': 'Deadzone',
      'gp.calibrate': 'Calibrate',
      'gp.cancel': 'Cancel calibration',
      'gp.reset': 'Reset mapping',
      'gp.calibrating': 'Calibrating',
      'gp.pressInput': 'Press {step} (button or stick direction)',
      'gp.releaseNeutral': 'Release all buttons and center sticks…',
      'gp.duplicate': 'Already used for {name} — choose another input',
      'gp.done': 'Calibration complete and saved',
      'gp.deleted': 'Device profile deleted',
      'gp.cancelled': 'Calibration cancelled (not saved)',
      'gp.disconnected': 'Gamepad disconnected — calibration cancelled',
      'gp.unnamed': 'Unnamed gamepad',
      'gp.progress': '{i}/{n}',
    },
  }

  function create(React, api) {
    if (!React || typeof React.createElement !== 'function') {
      throw new Error('GameBenchGamepadSettings.create(React, api) 需要一个有效的 React')
    }
    var h = React.createElement
    var Fragment = React.Fragment || 'div'
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    // ---- 跨组件复用的纯工具（不缓存 api 值）-------------------------------

    function readPads() {
      try {
        var nav = typeof navigator !== 'undefined' ? navigator : root.navigator
        if (!nav || typeof nav.getGamepads !== 'function') return []
        var list = nav.getGamepads()
        if (!list) return []
        var out = []
        for (var i = 0; i < list.length; i += 1) {
          var pad = list[i]
          if (pad && pad.connected !== false) out.push(pad)
        }
        return out
      } catch {
        return []
      }
    }

    function gamepadsLib() {
      var lib = root.GameBenchGamepads
      return lib && typeof lib.identify === 'function' && typeof lib.key === 'function' ? lib : null
    }

    function deviceKey(pad) {
      var lib = gamepadsLib()
      if (lib) {
        try {
          var key = lib.key(pad)
          if (key) return key
        } catch {
          /* ignore */
        }
      }
      var id = pad && typeof pad.id === 'string' && pad.id.trim() ? pad.id.trim().toLowerCase() : ''
      if (id) return id
      var index = pad && typeof pad.index === 'number' ? pad.index : 0
      return 'gamepad-' + index
    }

    function identifyPad(pad) {
      var lib = gamepadsLib()
      if (lib) {
        try {
          return lib.identify(pad)
        } catch {
          /* ignore */
        }
      }
      return {
        name: pad && typeof pad.id === 'string' && pad.id ? pad.id : '',
        nintendo: false,
        side: null,
        standard: !!(pad && pad.mapping === 'standard'),
        needsMapping: false,
      }
    }

    function readSnapshot(pad) {
      var pressed = new Set()
      var buttons = pad && pad.buttons ? pad.buttons : []
      for (var i = 0; i < buttons.length; i += 1) {
        var button = buttons[i]
        var down = false
        if (typeof button === 'number') down = button > 0.5
        else if (button) {
          down = button.pressed === true || (typeof button.value === 'number' && button.value > 0.5)
        }
        if (down) pressed.add(i)
      }
      var axes = []
      var rawAxes = pad && pad.axes ? pad.axes : []
      for (var j = 0; j < rawAxes.length; j += 1) {
        var value = rawAxes[j]
        axes.push(typeof value === 'number' && isFinite(value) ? value : 0)
      }
      return { pressed: pressed, axes: axes }
    }

    function isNeutral(snapshot, baseline) {
      if (snapshot.pressed.size > 0) return false
      var count = Math.max(snapshot.axes.length, baseline.axes.length)
      for (var i = 0; i < count; i += 1) {
        var now = typeof snapshot.axes[i] === 'number' ? snapshot.axes[i] : 0
        var base = typeof baseline.axes[i] === 'number' ? baseline.axes[i] : 0
        if (Math.abs(now - base) > NEUTRAL_TOLERANCE) return false
      }
      return true
    }

    // 返回 { button:index } 或 { axis:index, direction:-1|1 }；优先新按下的按钮。
    function detectInput(snapshot, baseline) {
      var maxButton = 0
      snapshot.pressed.forEach(function (index) {
        if (index > maxButton) maxButton = index
      })
      if (maxButton < 64) {
        for (var i = 0; i <= maxButton; i += 1) {
          if (snapshot.pressed.has(i) && !baseline.pressed.has(i)) return { button: i }
        }
      }

      var bestAxis = -1
      var bestDelta = 0
      for (var j = 0; j < snapshot.axes.length; j += 1) {
        var now = snapshot.axes[j]
        var base = typeof baseline.axes[j] === 'number' ? baseline.axes[j] : 0
        var delta = Math.abs(now - base)
        if (delta >= AXIS_TRIGGER && delta > bestDelta) {
          bestAxis = j
          bestDelta = delta
        }
      }
      if (bestAxis >= 0) {
        return { axis: bestAxis, direction: snapshot.axes[bestAxis] >= 0 ? 1 : -1 }
      }
      return null
    }

    function bindingEqual(a, b) {
      if (!a || !b) return false
      if (typeof a.button === 'number' && typeof b.button === 'number') return a.button === b.button
      if (typeof a.axis === 'number' && typeof b.axis === 'number') {
        return a.axis === b.axis && a.direction === b.direction
      }
      return false
    }

    function bindingOwner(bindings, input) {
      var names = Object.keys(bindings || {})
      for (var i = 0; i < names.length; i += 1) {
        if (bindingEqual(bindings[names[i]], input)) return names[i]
      }
      return ''
    }

    function clampDeadZone(value) {
      var number = typeof value === 'number' && isFinite(value) ? value : DEFAULT_DEAD_ZONE
      if (number < MIN_DEAD_ZONE) number = MIN_DEAD_ZONE
      if (number > MAX_DEAD_ZONE) number = MAX_DEAD_ZONE
      return Math.round(number * 100) / 100
    }

    function readProfiles() {
      try {
        var value = api && typeof api.getProfiles === 'function' ? api.getProfiles() : null
        return value && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    function writeProfiles(profiles) {
      if (!api || typeof api.saveProfiles !== 'function') return false
      try {
        api.saveProfiles(profiles)
        return true
      } catch {
        return false
      }
    }

    function readPaired() {
      try {
        return !!(api && typeof api.getPaired === 'function' && api.getPaired())
      } catch {
        return false
      }
    }

    function readNoticeExtra(key, vars) {
      var locale = api && typeof api.locale === 'string' ? api.locale : ''
      var lang = locale && locale.toLowerCase().indexOf('zh') === 0 ? 'zh' : locale ? 'en' : 'zh'
      var table = STRINGS[lang] || STRINGS.zh
      var value = table[key] != null ? table[key] : STRINGS.zh[key] != null ? STRINGS.zh[key] : key
      if (vars) {
        for (var name in vars) {
          if (hasOwn.call(vars, name)) value = value.split('{' + name + '}').join(String(vars[name]))
        }
      }
      return value
    }

    function translate(key, vars) {
      if (api && typeof api.t === 'function') {
        try {
          var external = api.t(key)
          if (typeof external === 'string' && external && external !== key) {
            if (vars) {
              for (var name in vars) {
                if (hasOwn.call(vars, name)) external = external.split('{' + name + '}').join(String(vars[name]))
              }
            }
            return external
          }
        } catch {
          /* fall through to built-in */
        }
      }
      return readNoticeExtra(key, vars)
    }

    function makeSwitch(id, label, checked, onToggle) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': !!checked,
          className: 'gb-switch' + (checked ? ' is-on' : ''),
          'data-gb-switch': id,
          onClick: onToggle,
        },
        h('span', { className: 'gb-switch-track' }, h('span', { className: 'gb-switch-knob' })),
        h('span', { className: 'gb-switch-text' }, label),
      )
    }

    // ---- React 组件 -------------------------------------------------------

    function GamepadSettings() {
      var frameState = useState(0)
      var setFrame = frameState[1]
      var calibrationState = useState(null)
      var calibrationForRender = calibrationState[0]
      var setCalibrationState = calibrationState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var padsRef = useRef([])
      var calibrationRef = useRef(null)

      function applyCalibration(next) {
        calibrationRef.current = next
        setCalibrationState(next)
      }

      function cancelCalibration(noticeKey) {
        applyCalibration(null)
        if (noticeKey) setNotice({ type: 'quiet', key: noticeKey })
      }

      function saveProfile(deviceKeyValue, patch) {
        var profiles = readProfiles()
        var next = {}
        for (var name in profiles) {
          if (hasOwn.call(profiles, name)) next[name] = profiles[name]
        }
        var previous = next[deviceKeyValue] && typeof next[deviceKeyValue] === 'object' ? next[deviceKeyValue] : {}
        var merged = {}
        for (var name2 in previous) {
          if (hasOwn.call(previous, name2)) merged[name2] = previous[name2]
        }
        for (var name3 in patch) {
          if (hasOwn.call(patch, name3)) merged[name3] = patch[name3]
        }
        next[deviceKeyValue] = merged
        writeProfiles(next)
      }

      function saveCalibratedBindings(deviceKeyValue, bindings) {
        var profiles = readProfiles()
        var next = {}
        for (var name in profiles) {
          if (hasOwn.call(profiles, name)) next[name] = profiles[name]
        }
        var previous = next[deviceKeyValue] && typeof next[deviceKeyValue] === 'object' ? next[deviceKeyValue] : {}
        var merged = {}
        for (var name2 in previous) {
          if (hasOwn.call(previous, name2)) merged[name2] = previous[name2]
        }
        merged.bindings = bindings
        next[deviceKeyValue] = merged
        writeProfiles(next)
      }

      function resetProfile(deviceKeyValue) {
        var profiles = readProfiles()
        var next = {}
        for (var name in profiles) {
          if (hasOwn.call(profiles, name) && name !== deviceKeyValue) next[name] = profiles[name]
        }
        writeProfiles(next)
        if (calibrationRef.current && calibrationRef.current.key === deviceKeyValue) {
          cancelCalibration(null)
        }
        setNotice({ type: 'quiet', key: 'gp.deleted' })
      }

      function startCalibration(pad) {
        var snapshot = readSnapshot(pad)
        var baseline = { pressed: new Set(snapshot.pressed), axes: snapshot.axes.slice() }
        var calibration = {
          key: deviceKey(pad),
          stepIndex: 0,
          bindings: {},
          baseline: baseline,
          armed: false,
          hint: '',
          hintName: '',
        }
        calibrationRef.current = calibration
        setCalibrationState(calibration)
        setNotice(null)
      }

      function togglePaired() {
        if (!api || typeof api.setPaired !== 'function') return
        try {
          api.setPaired(!readPaired())
        } catch {
          /* ignore */
        }
      }

      function stepCalibration(calibration, pad) {
        var snapshot = readSnapshot(pad)
        if (!calibration.armed) {
          if (!isNeutral(snapshot, calibration.baseline)) return calibration
          return Object.assign({}, calibration, { armed: true })
        }
        var input = detectInput(snapshot, calibration.baseline)
        if (!input) return calibration
        var stepName = STEPS[calibration.stepIndex]
        var owner = bindingOwner(calibration.bindings, input)
        if (owner) {
          return Object.assign({}, calibration, {
            armed: false,
            hint: 'gp.duplicate',
            hintName: owner,
          })
        }
        var bindings = Object.assign({}, calibration.bindings)
        bindings[stepName] = input
        var nextIndex = calibration.stepIndex + 1
        if (nextIndex >= STEPS.length) return { done: true, bindings: bindings }
        return Object.assign({}, calibration, {
          stepIndex: nextIndex,
          bindings: bindings,
          armed: false,
          hint: '',
          hintName: '',
        })
      }

      // 每 100ms 轮询连接/输入，并在校准中推进状态机
      useEffect(function () {
        var alive = true
        function poll() {
          if (!alive) return
          var pads = readPads()
          padsRef.current = pads

          var calibration = calibrationRef.current
          if (calibration) {
            var pad = null
            for (var i = 0; i < pads.length; i += 1) {
              if (deviceKey(pads[i]) === calibration.key) {
                pad = pads[i]
                break
              }
            }
            if (!pad) {
              calibrationRef.current = null
              setCalibrationState(null)
              setNotice({ type: 'warn', key: 'gp.disconnected' })
            } else {
              var result = stepCalibration(calibration, pad)
              if (result && result.done) {
                saveCalibratedBindings(calibration.key, result.bindings)
                calibrationRef.current = null
                setCalibrationState(null)
                setNotice({ type: 'ok', key: 'gp.done' })
              } else if (result && result !== calibration) {
                calibrationRef.current = result
                setCalibrationState(result)
              }
            }
          }

          setFrame(function (value) {
            return value + 1
          })
        }
        poll()
        var timer = setInterval(poll, POLL_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [])

      // ESC 取消校准（不保存半成品）；组件卸载时由 cleanup 移除监听
      useEffect(
        function () {
          if (!calibrationForRender) return undefined
          function onKeyDown(event) {
            var key = event && (event.key || event.code)
            if (key === 'Escape' || key === 'Esc') {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
              calibrationRef.current = null
              setCalibrationState(null)
              setNotice({ type: 'quiet', key: 'gp.cancelled' })
            }
          }
          root.addEventListener('keydown', onKeyDown, true)
          return function () {
            root.removeEventListener('keydown', onKeyDown, true)
          }
        },
        [calibrationForRender],
      )

      // 提示信息自动消失
      useEffect(
        function () {
          if (!notice) return undefined
          var timer = setTimeout(
            function () {
              setNotice(null)
            },
            notice.type === 'warn' ? 3500 : 2000,
          )
          return function () {
            clearTimeout(timer)
          }
        },
        [notice],
      )

      var pads = padsRef.current
      var profiles = readProfiles()
      var paired = readPaired()
      var hasGamepadsLib = !!gamepadsLib()

      var children = [
        h(
          'section',
          { className: 'gb-panel', key: 'gb-gamepad-settings', 'data-gb-gamepad-settings': '' },
          h('h2', { className: 'gb-panel-title' }, translate('gp.title')),
          h('p', { className: 'gb-panel-desc' }, translate('gp.pairHint')),
          !hasGamepadsLib ? h('p', { className: 'gb-field-hint' }, translate('gp.needModule')) : null,
          h(
            'div',
            { className: 'gb-field' },
            makeSwitch('gb-merge-joycon', translate('gp.merge'), paired, togglePaired),
          ),
        ),
      ]

      if (pads.length === 0) {
        children.push(
          h(
            'section',
            { className: 'gb-panel', key: 'gb-gamepads-empty' },
            h('p', { className: 'gb-field-hint' }, translate('gp.noPads')),
          ),
        )
      } else {
        pads.forEach(function (pad, index) {
          children.push(renderDevicePanel(pad, index, profiles))
        })
      }

      if (notice) {
        children.push(
          h(
            'p',
            {
              className: 'gb-field-hint',
              key: 'gb-gamepad-notice',
              'data-gb-gamepad-notice': notice.type || 'info',
            },
            translate(notice.key),
          ),
        )
      }

      return h(Fragment, null, children)

      // ---- 单个设备面板 ---------------------------------------------------
      function renderDevicePanel(pad, index, allProfiles) {
        var deviceKeyValue = deviceKey(pad)
        var info = identifyPad(pad)
        var profile = allProfiles && allProfiles[deviceKeyValue] ? allProfiles[deviceKeyValue] : {}
        var swapAB = profile.swapAB === true
        var deadZone = clampDeadZone(profile.deadZone)
        var bindings = profile.bindings && typeof profile.bindings === 'object' ? profile.bindings : null
        var calibrated = !!(bindings && Object.keys(bindings).length > 0)
        var snapshot = readSnapshot(pad)
        var activeCalibration =
          calibrationForRender && calibrationForRender.key === deviceKeyValue ? calibrationForRender : null

        var inputChips = []
        snapshot.pressed.forEach(function (buttonIndex) {
          inputChips.push(
            h(
              'span',
              { className: 'gb-chip', key: 'button-' + buttonIndex, 'data-gb-pad-button': String(buttonIndex) },
              'B' + buttonIndex,
            ),
          )
        })
        snapshot.axes.forEach(function (value, axisIndex) {
          if (axisIndex > 7) return
          var moved = Math.abs(value) >= 0.2
          inputChips.push(
            h(
              'span',
              {
                className: 'gb-chip' + (moved ? '' : ' gb-chip-quiet'),
                key: 'axis-' + axisIndex,
                'data-gb-pad-axis': String(axisIndex),
              },
              'A' + axisIndex + ' ' + value.toFixed(2),
            ),
          )
        })
        if (inputChips.length === 0) {
          inputChips.push(h('span', { className: 'gb-chip gb-chip-quiet', key: 'input-none' }, translate('gp.none')))
        }

        var statusChip = h(
          'span',
          { className: 'gb-chip ' + (info.needsMapping ? 'gb-chip-warn' : 'gb-chip-quiet') },
          info.needsMapping ? translate('gp.needsCalibration') : translate('gp.standard'),
        )

        var stepLabel = activeCalibration ? STEPS[activeCalibration.stepIndex] : ''
        var progressText = activeCalibration
          ? translate('gp.progress', { i: activeCalibration.stepIndex + 1, n: STEPS.length })
          : ''

        var calibrationChildren = null
        if (activeCalibration) {
          var stepChips = STEPS.map(function (stepName, stepIndex) {
            var className = 'gb-chip gb-chip-quiet'
            if (stepIndex < activeCalibration.stepIndex) className = 'gb-chip'
            else if (stepIndex === activeCalibration.stepIndex) className = 'gb-chip is-active'
            return h('span', { className: className, key: 'step-' + stepName }, stepName)
          })
          calibrationChildren = h(
            'div',
            { className: 'gb-field', 'data-gb-calibrating': deviceKeyValue },
            h(
              'div',
              { className: 'gb-field-row' },
              h('span', { className: 'gb-field-label' }, translate('gp.calibrating')),
              h('span', { className: 'gb-field-value' }, progressText),
            ),
            h(
              'p',
              { className: 'gb-field-hint' },
              activeCalibration.armed
                ? translate('gp.pressInput', { step: stepLabel })
                : translate('gp.releaseNeutral'),
            ),
            h('div', { className: 'gb-chips' }, stepChips),
            activeCalibration.hint
              ? h(
                  'p',
                  { className: 'gb-field-hint' },
                  translate(activeCalibration.hint, { name: activeCalibration.hintName || '' }),
                )
              : null,
          )
        }

        return h(
          'section',
          {
            className: 'gb-panel gb-gamepad-card',
            key: 'gb-gamepad-' + deviceKeyValue + '#' + index,
            'data-gb-gamepad': deviceKeyValue,
          },
          h(
            'div',
            { className: 'gb-field-row' },
            h('h3', { className: 'gb-panel-title' }, info.name || translate('gp.unnamed')),
            statusChip,
            info.side
              ? h(
                  'span',
                  { className: 'gb-chip gb-chip-quiet' },
                  info.side === 'left' ? translate('gp.left') : translate('gp.right'),
                )
              : null,
            calibrated ? h('span', { className: 'gb-chip gb-chip-quiet' }, translate('gp.calibrated')) : null,
          ),
          h(
            'div',
            { className: 'gb-field' },
            h('span', { className: 'gb-field-label' }, translate('gp.input')),
            h('div', { className: 'gb-chips', 'data-gb-pad-input': deviceKeyValue }, inputChips),
          ),
          h(
            'div',
            { className: 'gb-field gb-field-inline' },
            makeSwitch('gb-swap-ab-' + index, translate('gp.swapAB'), swapAB, function () {
              saveProfile(deviceKeyValue, { swapAB: !swapAB })
            }),
          ),
          h(
            'div',
            { className: 'gb-field' },
            h('label', { className: 'gb-field-label', htmlFor: 'gb-deadzone-' + index }, translate('gp.deadZone')),
            h(
              'div',
              { className: 'gb-field-row gb-slider-row' },
              h('input', {
                id: 'gb-deadzone-' + index,
                type: 'range',
                className: 'gb-range',
                min: MIN_DEAD_ZONE,
                max: MAX_DEAD_ZONE,
                step: DEAD_ZONE_STEP,
                value: deadZone,
                'data-gb-pad-deadzone': deviceKeyValue,
                onChange: function (event) {
                  saveProfile(deviceKeyValue, { deadZone: clampDeadZone(Number(event.target.value)) })
                },
              }),
              h('span', { className: 'gb-field-value' }, deadZone.toFixed(2)),
            ),
          ),
          h(
            'div',
            { className: 'gb-field-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'gb-btn gb-btn-accent',
                'data-gb-pad-calibrate': deviceKeyValue,
                onClick: function () {
                  if (activeCalibration) cancelCalibration('gp.cancelled')
                  else startCalibration(pad)
                },
              },
              activeCalibration ? translate('gp.cancel') : translate('gp.calibrate'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'gb-btn',
                'data-gb-pad-reset': deviceKeyValue,
                onClick: function () {
                  resetProfile(deviceKeyValue)
                },
              },
              translate('gp.reset'),
            ),
          ),
          calibrationChildren,
        )
      }
    }

    return GamepadSettings
  }

  root.GameBenchGamepadSettings = { create: create }
})()
