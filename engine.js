/**
 * 拾光游戏厅 — NES 模拟器运行时（engine.js）
 *
 * 依赖 jsnes 2.1.0 (Apache-2.0, https://github.com/bfirsh/jsnes)。
 * jsnes 由 Host 以 /game-bench/api/vendor/jsnes.js 先在页面上加载（UMD → window.jsnes），
 * 之后再由 Host 加载本文件。本文件是自包含 IIFE：
 *   - 不 import 任何模块、不访问文件系统、不发网络请求；
 *   - 只在 window 上暴露 window.GameBenchCore.create(options) 与版本号；
 *   - 不绑定 document 级键盘事件、不创建可见 DOM、不改页面样式。
 *
 * 契约见 dsh-game-bench/docs/ENGINE.md。
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

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------
  var ENGINE_VERSION = '1.0.0'
  var SCREEN_W = 256
  var SCREEN_H = 240
  var PIXEL_COUNT = SCREEN_W * SCREEN_H
  var TARGET_FPS = 60.098
  var FRAME_MS = 1000 / TARGET_FPS
  var MAX_CATCHUP_FRAMES = 4
  var FPS_WINDOW_MS = 1000
  var AUDIO_RING_FRAMES = 8192 // ≈170ms @48kHz
  var AUDIO_STAGING_FRAMES = 4096 // 单次 flush 的最大帧数（4 帧补救约 3200）
  var SCRIPT_BUFFER_SIZE = 1024

  // jsnes UMD 只导出 { Browser, Controller, GameGenie, NES }，按钮常量取自 Controller；
  // 万一 Controller 常量缺失则用文档里的固定值兜底。
  var FALLBACK_BUTTONS = {
    A: 0,
    B: 1,
    SELECT: 2,
    START: 3,
    UP: 4,
    DOWN: 5,
    LEFT: 6,
    RIGHT: 7,
    TURBO_A: 8,
    TURBO_B: 9,
  }
  var BUTTON_PROP_NAMES = {
    A: 'BUTTON_A',
    B: 'BUTTON_B',
    SELECT: 'BUTTON_SELECT',
    START: 'BUTTON_START',
    UP: 'BUTTON_UP',
    DOWN: 'BUTTON_DOWN',
    LEFT: 'BUTTON_LEFT',
    RIGHT: 'BUTTON_RIGHT',
    TURBO_A: 'BUTTON_TURBO_A',
    TURBO_B: 'BUTTON_TURBO_B',
  }

  // AudioWorklet 处理器源码：以 Blob URL 内联注入（不额外请求静态文件）。
  // 这是一个独立作用域的模块代码，仅使用 AudioWorkletGlobalScope 的 API。
  var WORKLET_CODE =
    'class GameBenchAudioProcessor extends AudioWorkletProcessor {\n' +
    '  constructor(options) {\n' +
    '    super()\n' +
    '    const opts = (options && options.processorOptions) || {}\n' +
    '    const requested = opts.capacityFrames | 0\n' +
    '    const cap = requested > 0 ? requested : 8192\n' +
    '    this.capacity = cap\n' +
    '    this.ringL = new Float32Array(cap)\n' +
    '    this.ringR = new Float32Array(cap)\n' +
    '    this.readIndex = 0\n' +
    '    this.writeIndex = 0\n' +
    '    this.available = 0\n' +
    '    this.port.onmessage = (event) => {\n' +
    '      const msg = event.data\n' +
    '      if (!msg) return\n' +
    '      if (msg.type === "push" && msg.samples) this.push(msg.samples)\n' +
    '      else if (msg.type === "clear") this.clear()\n' +
    '    }\n' +
    '  }\n' +
    '  clear() {\n' +
    '    this.readIndex = 0\n' +
    '    this.writeIndex = 0\n' +
    '    this.available = 0\n' +
    '  }\n' +
    '  push(samples) {\n' +
    '    const count = samples.length >> 1\n' +
    '    const cap = this.capacity\n' +
    '    for (let i = 0; i < count; i++) {\n' +
    '      if (this.available >= cap) return\n' +
    '      const j = i << 1\n' +
    '      this.ringL[this.writeIndex] = samples[j]\n' +
    '      this.ringR[this.writeIndex] = samples[j + 1]\n' +
    '      this.writeIndex = (this.writeIndex + 1) % cap\n' +
    '      this.available++\n' +
    '    }\n' +
    '  }\n' +
    '  process(inputs, outputs) {\n' +
    '    const output = outputs && outputs[0]\n' +
    '    if (!output || !output[0]) return true\n' +
    '    const left = output[0]\n' +
    '    const right = output.length > 1 ? output[1] : output[0]\n' +
    '    const cap = this.capacity\n' +
    '    for (let i = 0; i < left.length; i++) {\n' +
    '      if (this.available > 0) {\n' +
    '        left[i] = this.ringL[this.readIndex]\n' +
    '        right[i] = this.ringR[this.readIndex]\n' +
    '        this.readIndex = (this.readIndex + 1) % cap\n' +
    '        this.available--\n' +
    '      } else {\n' +
    '        left[i] = 0\n' +
    '        right[i] = 0\n' +
    '      }\n' +
    '    }\n' +
    '    return true\n' +
    '  }\n' +
    '}\n' +
    'registerProcessor("game-bench-audio-processor", GameBenchAudioProcessor)\n'

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  var defer =
    typeof queueMicrotask === 'function'
      ? queueMicrotask
      : function (fn) {
          Promise.resolve().then(fn)
        }

  function noop() {}

  function isDebug() {
    try {
      return !!root.__GAME_BENCH_DEBUG__
    } catch (err) {
      return false
    }
  }

  function debugLog() {
    if (!isDebug()) return
    try {
      if (typeof console !== 'undefined' && console && typeof console.debug === 'function') {
        var args = Array.prototype.slice.call(arguments)
        args.unshift('[game-bench]')
        console.debug.apply(console, args)
      }
    } catch (err) {
      /* 调试日志本身永不致命 */
    }
  }

  function makeError(message, code, cause) {
    var error = new Error(message)
    if (code) error.code = code
    if (cause) error.cause = cause
    return error
  }

  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        return performance.now()
      }
    } catch (err) {
      /* ignore */
    }
    return Date.now()
  }

  function requestFrame(callback) {
    try {
      if (typeof root.requestAnimationFrame === 'function') {
        return root.requestAnimationFrame(callback)
      }
    } catch (err) {
      /* 落到 setTimeout 兜底 */
    }
    return setTimeout(function () {
      callback(nowMs())
    }, 16)
  }

  function cancelFrame(handle) {
    if (handle == null) return
    try {
      if (typeof root.cancelAnimationFrame === 'function') {
        root.cancelAnimationFrame(handle)
        return
      }
    } catch (err) {
      /* ignore */
    }
    try {
      clearTimeout(handle)
    } catch (err) {
      /* ignore */
    }
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min
    if (value < min) return min
    if (value > max) return max
    return value
  }

  function clampVolume(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0.8
    return clamp(value, 0, 1)
  }

  function normalizeSpeed(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 1
    return clamp(value, 0.25, 3)
  }

  function resolveAudioContextCtor() {
    try {
      if (typeof root.AudioContext === 'function') return root.AudioContext
      if (typeof root.webkitAudioContext === 'function') return root.webkitAudioContext
    } catch (err) {
      /* ignore */
    }
    return null
  }

  function utf8Encode(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text)
    throw makeError('GameBench: 当前环境缺少 TextEncoder，无法生成存档', 'SAVE_FAILED')
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes)
    throw makeError('GameBench: 当前环境缺少 TextDecoder，无法读取存档', 'BAD_STATE')
  }

  function readAllBytes(readable) {
    return new Promise(function (resolve, reject) {
      var reader = readable.getReader()
      var chunks = []
      var total = 0
      function pump() {
        reader.read().then(function (result) {
          if (result.done) {
            var out = new Uint8Array(total)
            var offset = 0
            for (var i = 0; i < chunks.length; i++) {
              out.set(chunks[i], offset)
              offset += chunks[i].length
            }
            resolve(out)
            return
          }
          var value = result.value
          if (value) {
            chunks.push(value)
            total += value.length
          }
          pump()
        }, reject)
      }
      pump()
    })
  }

  // gzip：CompressionStream（Chrome 80+ / Safari 16.4+）；缺失时由调用方回退裸 JSON。
  // 注意：写入与读取两侧都可能异步失败，必须都挂上拒绝处理，否则会留下 unhandledrejection。
  function transformBytes(bytes, StreamCtor, code) {
    return new Promise(function (resolve, reject) {
      var settled = false
      function fail(error) {
        if (settled) return
        settled = true
        reject(error)
      }
      function done(value) {
        if (settled) return
        settled = true
        resolve(value)
      }
      var transform
      try {
        transform = new StreamCtor('gzip')
      } catch (error) {
        fail(error)
        return
      }
      readAllBytes(transform.readable).then(done, fail)
      try {
        var writer = transform.writable.getWriter()
        writer
          .write(bytes)
          .then(function () {
            return writer.close()
          })
          .catch(fail)
      } catch (error) {
        fail(error)
      }
    }).catch(function (error) {
      throw makeError('GameBench: gzip 处理失败', code, error)
    })
  }

  function gzipBytes(bytes) {
    if (typeof CompressionStream !== 'function') {
      return Promise.reject(makeError('当前环境不支持 CompressionStream', 'UNSUPPORTED'))
    }
    return transformBytes(bytes, CompressionStream, 'SAVE_FAILED')
  }

  function gunzipBytes(bytes) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(makeError('当前环境不支持 DecompressionStream', 'UNSUPPORTED'))
    }
    return transformBytes(bytes, DecompressionStream, 'BAD_STATE')
  }

  function toUint8Array(data) {
    if (data == null) throw makeError('GameBench: 数据为空', 'BAD_ROM')
    if (typeof data === 'string') {
      // 兼容二进制字符串（jsnes 自身也接受这种形式）
      var out = new Uint8Array(data.length)
      for (var i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff
      return out
    }
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      return new Uint8Array(data)
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    if (Array.isArray(data)) return Uint8Array.from(data)
    throw makeError('GameBench: 无法识别的数据类型（需要 Uint8Array/ArrayBuffer）', 'BAD_ROM')
  }

  // iNES / NES 2.0 头里没有游戏标题字段（只有 UNIF 才有，jsnes 不支持 UNIF），
  // 因此这里保守地返回 ''，标题由 client 的游戏库元数据提供。
  function extractRomTitle() {
    return ''
  }

  function buildButtonCodes(ControllerCtor) {
    var codes = {}
    Object.keys(BUTTON_PROP_NAMES).forEach(function (name) {
      var code
      if (ControllerCtor) {
        try {
          code = ControllerCtor[BUTTON_PROP_NAMES[name]]
        } catch (err) {
          code = undefined
        }
      }
      codes[name] = typeof code === 'number' ? code : FALLBACK_BUTTONS[name]
    })
    return codes
  }

  // ---------------------------------------------------------------------------
  // 渲染：把 jsnes 的 Uint32Array(256*240, 0x00BBGGRR) 画到 canvas
  // ---------------------------------------------------------------------------
  function Renderer(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw makeError('GameBench: create() 需要传入有效的 canvas 元素', 'NO_CANVAS')
    }
    try {
      canvas.width = SCREEN_W
      canvas.height = SCREEN_H
    } catch (err) {
      throw makeError('GameBench: 无法设置 canvas 尺寸', 'NO_CANVAS', err)
    }

    var context = null
    try {
      context = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d')
    } catch (err) {
      context = null
    }
    if (!context || typeof context.createImageData !== 'function' || typeof context.putImageData !== 'function') {
      throw makeError('GameBench: 当前环境不支持 canvas 2D / ImageData', 'NO_IMAGEDATA')
    }

    var imageData = null
    try {
      imageData = context.createImageData(SCREEN_W, SCREEN_H)
    } catch (err) {
      throw makeError('GameBench: 无法创建 ImageData', 'NO_IMAGEDATA', err)
    }
    if (!imageData || !imageData.data || imageData.data.length !== PIXEL_COUNT * 4) {
      throw makeError('GameBench: 无法创建 ImageData', 'NO_IMAGEDATA')
    }

    this.canvas = canvas
    this.context = context
    this.imageData = imageData
    this.pixels32 = null
    try {
      var buffer = imageData.data.buffer
      if (buffer && buffer.byteLength >= PIXEL_COUNT * 4) {
        // 小端序下 0xAABBGGRR → RGBA 字节序 RR GG BB AA，与 ImageData 布局一致
        this.pixels32 = new Uint32Array(buffer, 0, PIXEL_COUNT)
      }
    } catch (err) {
      this.pixels32 = null
    }
  }

  Renderer.prototype.draw = function (frameBuffer) {
    if (!frameBuffer || frameBuffer.length < PIXEL_COUNT) return
    var pixels = this.pixels32
    var i
    if (pixels) {
      for (i = 0; i < PIXEL_COUNT; i++) {
        pixels[i] = 0xff000000 | frameBuffer[i]
      }
    } else {
      var data = this.imageData.data
      for (i = 0; i < PIXEL_COUNT; i++) {
        var value = frameBuffer[i]
        var offset = i << 2
        data[offset] = value & 0xff
        data[offset + 1] = (value >> 8) & 0xff
        data[offset + 2] = (value >> 16) & 0xff
        data[offset + 3] = 0xff
      }
    }
    try {
      this.context.putImageData(this.imageData, 0, 0)
    } catch (err) {
      debugLog('putImageData 失败', err)
    }
  }

  Renderer.prototype.clear = function () {
    try {
      if (this.pixels32) {
        this.pixels32.fill(0xff000000)
      } else {
        var data = this.imageData.data
        for (var i = 0; i < PIXEL_COUNT; i++) {
          data[i << 2] = 0
          data[(i << 2) + 1] = 0
          data[(i << 2) + 2] = 0
          data[(i << 2) + 3] = 0xff
        }
      }
      this.context.putImageData(this.imageData, 0, 0)
    } catch (err) {
      debugLog('清屏失败', err)
    }
  }

  // ---------------------------------------------------------------------------
  // 截图：离线 canvas + toDataURL('image/png')
  // ---------------------------------------------------------------------------
  function SnapshotTaker(renderer) {
    this.renderer = renderer
    this.offscreen = null
  }

  SnapshotTaker.prototype.capture = function () {
    try {
      if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
        return ''
      }
      if (!this.offscreen) {
        var canvas = document.createElement('canvas')
        canvas.width = SCREEN_W
        canvas.height = SCREEN_H
        this.offscreen = canvas
      }
      var context = this.offscreen.getContext('2d')
      if (!context || typeof context.putImageData !== 'function' || typeof this.offscreen.toDataURL !== 'function') {
        return ''
      }
      context.putImageData(this.renderer.imageData, 0, 0)
      return this.offscreen.toDataURL('image/png')
    } catch (err) {
      debugLog('snapshot 失败', err)
      return ''
    }
  }

  // ---------------------------------------------------------------------------
  // 音频：AudioWorklet 优先，ScriptProcessor 降级，无 AudioContext 则静音
  // ---------------------------------------------------------------------------
  function AudioEngine(options) {
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : noop
    this.volume = clampVolume(options.volume)
    this.muted = !!options.muted
    this.state = 'off'
    this.ready = false
    this.mode = null // 'worklet' | 'script' | null
    this.ctx = null
    this.gain = null
    this.workletNode = null
    this.scriptNode = null
    this.ring = null
    this.staging = new Float32Array(AUDIO_STAGING_FRAMES * 2)
    this.stagedFrames = 0
    this.resampleBuffer = new Float32Array(AUDIO_STAGING_FRAMES * 2 * 4)
    this._wantAudio = false
    this._destroyed = false
    this._graphPromise = null
    this._gestureCleanup = null
    this._blobUrl = null
    this._ctxStateHandler = null
    this._initContext()
  }

  AudioEngine.prototype.sampleRate = function () {
    return this.ctx && typeof this.ctx.sampleRate === 'number' ? this.ctx.sampleRate : 48000
  }

  AudioEngine.prototype._setState = function (next) {
    if (this.state === next) return
    this.state = next
    if (!this._destroyed) this.onStateChange()
  }

  AudioEngine.prototype._initContext = function () {
    var Ctor = resolveAudioContextCtor()
    if (!Ctor) {
      debugLog('当前环境没有 AudioContext，音频降级为 unsupported')
      this._setState('unsupported')
      return
    }
    var ctx = null
    try {
      ctx = new Ctor({ latencyHint: 'interactive' })
    } catch (err) {
      try {
        ctx = new Ctor()
      } catch (err2) {
        debugLog('AudioContext 创建失败，音频降级为 unsupported', err2)
        this._setState('unsupported')
        return
      }
    }
    this.ctx = ctx
    try {
      this.gain = ctx.createGain()
      this._applyGain()
      this.gain.connect(ctx.destination)
    } catch (err) {
      debugLog('GainNode 创建失败，音频降级为 unsupported', err)
      this.gain = null
      this._setState('unsupported')
      return
    }
    var self = this
    this._ctxStateHandler = function () {
      if (self._destroyed) return
      self._refreshPlaybackState()
    }
    try {
      if (typeof ctx.addEventListener === 'function') {
        ctx.addEventListener('statechange', this._ctxStateHandler)
      } else {
        ctx.onstatechange = this._ctxStateHandler
      }
    } catch (err) {
      /* ignore */
    }
    // 提前加载 worklet 模块（AudioContext 处于 suspended 时也能 addModule）
    this._graphPromise = this._buildGraph()
  }

  AudioEngine.prototype._buildGraph = function () {
    var self = this
    if (!this.ctx) return Promise.resolve()
    return Promise.resolve()
      .then(function () {
        return self._tryWorklet()
      })
      .then(function (ok) {
        if (self._destroyed) return
        if (ok) return
        self._tryScriptProcessor()
      })
      .catch(function (err) {
        debugLog('音频图构建异常', err)
      })
      .then(function () {
        if (!self._destroyed) self._refreshPlaybackState()
      })
  }

  AudioEngine.prototype._tryWorklet = function () {
    var self = this
    var ctx = this.ctx
    if (!ctx || !ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') return Promise.resolve(false)
    if (typeof root.AudioWorkletNode !== 'function') return Promise.resolve(false)
    if (typeof Blob !== 'function') return Promise.resolve(false)
    var URLCtor = root.URL || (typeof URL !== 'undefined' ? URL : null)
    if (!URLCtor || typeof URLCtor.createObjectURL !== 'function') return Promise.resolve(false)
    var url = null
    var node = null
    return Promise.resolve()
      .then(function () {
        url = URLCtor.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))
        self._blobUrl = url
        return ctx.audioWorklet.addModule(url)
      })
      .then(function () {
        if (self._destroyed) return false
        node = new root.AudioWorkletNode(ctx, 'game-bench-audio-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { capacityFrames: AUDIO_RING_FRAMES },
        })
        node.connect(self.gain)
        self.workletNode = node
        self.mode = 'worklet'
        self.ready = true
        return true
      })
      .catch(function (err) {
        debugLog('AudioWorklet 不可用，降级 ScriptProcessor', err)
        try {
          if (node) node.disconnect()
        } catch (err2) {
          /* ignore */
        }
        return false
      })
      .then(function (ok) {
        // addModule 成功后即可回收 Blob URL（模块已经加载进 worklet 全局）
        if (url) {
          try {
            URLCtor.revokeObjectURL(url)
          } catch (err) {
            /* ignore */
          }
          self._blobUrl = null
        }
        return ok
      })
  }

  AudioEngine.prototype._tryScriptProcessor = function () {
    var ctx = this.ctx
    if (!ctx || typeof ctx.createScriptProcessor !== 'function') {
      this.ready = false
      this._setState('unsupported')
      return
    }
    try {
      var node = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 0, 2)
      var self = this
      this.ring = {
        left: new Float32Array(AUDIO_RING_FRAMES),
        right: new Float32Array(AUDIO_RING_FRAMES),
        read: 0,
        write: 0,
        available: 0,
      }
      node.onaudioprocess = function (event) {
        self._fillScriptOutput(event)
      }
      node.connect(this.gain)
      this.scriptNode = node
      this.mode = 'script'
      this.ready = true
    } catch (err) {
      debugLog('ScriptProcessor 创建失败，音频降级为 unsupported', err)
      this.ready = false
      this._setState('unsupported')
    }
  }

  AudioEngine.prototype._fillScriptOutput = function (event) {
    var out = event && event.outputBuffer
    if (!out) return
    var left = out.getChannelData(0)
    var right = out.numberOfChannels > 1 ? out.getChannelData(1) : left
    var ring = this.ring
    if (!ring) {
      left.fill(0)
      if (right !== left) right.fill(0)
      return
    }
    for (var i = 0; i < left.length; i++) {
      if (ring.available > 0) {
        left[i] = ring.left[ring.read]
        right[i] = ring.right[ring.read]
        ring.read = (ring.read + 1) % AUDIO_RING_FRAMES
        ring.available--
      } else {
        left[i] = 0
        right[i] = 0
      }
    }
  }

  AudioEngine.prototype._applyGain = function () {
    if (!this.gain || !this.gain.gain) return
    var value = this.muted ? 0 : this.volume
    try {
      if (this.ctx && typeof this.gain.gain.setTargetAtTime === 'function') {
        this.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01)
      } else {
        this.gain.gain.value = value
      }
    } catch (err) {
      try {
        this.gain.gain.value = value
      } catch (err2) {
        /* ignore */
      }
    }
  }

  AudioEngine.prototype.start = function () {
    if (this._destroyed || this.state === 'unsupported') return
    this._wantAudio = true
    this._refreshPlaybackState()
    var self = this
    if (this._graphPromise) {
      this._graphPromise.then(function () {
        if (self._destroyed) return
        self._refreshPlaybackState()
        self._tryResume()
      })
      return
    }
    this._tryResume()
  }

  AudioEngine.prototype._tryResume = function () {
    var ctx = this.ctx
    if (!ctx || this._destroyed) return
    if (ctx.state === 'closed') return
    if (ctx.state === 'running') {
      this._refreshPlaybackState()
      return
    }
    var self = this
    try {
      var promise = ctx.resume()
      if (promise && typeof promise.then === 'function') {
        promise.then(
          function () {
            if (!self._destroyed) self._refreshPlaybackState()
          },
          function (err) {
            debugLog('AudioContext.resume 被拒绝（等待用户手势）', err)
            if (!self._destroyed) self._refreshPlaybackState()
          },
        )
      }
    } catch (err) {
      debugLog('AudioContext.resume 抛错', err)
    }
  }

  AudioEngine.prototype._refreshPlaybackState = function () {
    if (this._destroyed) return
    if (this.state === 'unsupported') return
    if (!this.ctx) {
      this._setState('unsupported')
      return
    }
    if (!this.ready) {
      this._setState(this._wantAudio ? 'starting' : 'off')
      return
    }
    if (!this._wantAudio) {
      this._setState('off')
      return
    }
    if (this.ctx.state === 'running') {
      this._setState('on')
      this._clearGestureUnlock()
      return
    }
    if (this.ctx.state === 'closed') {
      this._setState('unsupported')
      return
    }
    // suspended：被自动播放策略挡住，等下一次用户手势
    this._setState('blocked')
    this._installGestureUnlock()
  }

  AudioEngine.prototype._installGestureUnlock = function () {
    if (this._gestureCleanup || !this._wantAudio) return
    if (typeof root.addEventListener !== 'function') return
    var self = this
    var handler = function () {
      self._tryResume()
    }
    var events = ['pointerdown', 'keydown']
    events.forEach(function (name) {
      try {
        root.addEventListener(name, handler, true)
      } catch (err) {
        /* ignore */
      }
    })
    this._gestureCleanup = function () {
      events.forEach(function (name) {
        try {
          root.removeEventListener(name, handler, true)
        } catch (err) {
          /* ignore */
        }
      })
      self._gestureCleanup = null
    }
  }

  AudioEngine.prototype._clearGestureUnlock = function () {
    if (this._gestureCleanup) this._gestureCleanup()
  }

  AudioEngine.prototype.push = function (left, right) {
    if (!this.ready || this._destroyed) return
    var index = this.stagedFrames * 2
    this.staging[index] = left
    this.staging[index + 1] = right
    this.stagedFrames++
    if (this.stagedFrames >= AUDIO_STAGING_FRAMES) this.flush(1)
  }

  AudioEngine.prototype.flush = function (speed) {
    var frames = this.stagedFrames
    if (frames <= 0) return
    this.stagedFrames = 0
    if (!this.ready || this._destroyed) return

    var samples
    var count = frames
    if (typeof speed === 'number' && Number.isFinite(speed) && speed !== 1 && speed > 0) {
      // 倍速/半速时对样本做最近邻重采样，尽量保持“实时”听感（非高保真）
      count = Math.max(1, Math.round(frames / speed))
      if (count * 2 > this.resampleBuffer.length) count = this.resampleBuffer.length >> 1
      var out = this.resampleBuffer
      var maxSrc = frames - 1
      for (var i = 0; i < count; i++) {
        var src = Math.floor(i * speed)
        if (src > maxSrc) src = maxSrc
        var si = src * 2
        var oi = i * 2
        out[oi] = this.staging[si]
        out[oi + 1] = this.staging[si + 1]
      }
      samples = out.subarray(0, count * 2)
    } else {
      samples = this.staging.subarray(0, frames * 2)
    }

    if (this.mode === 'worklet' && this.workletNode) {
      var chunk = new Float32Array(samples.length)
      chunk.set(samples)
      try {
        this.workletNode.port.postMessage({ type: 'push', samples: chunk })
      } catch (err) {
        debugLog('向 AudioWorklet 推送样本失败', err)
      }
      return
    }
    if (this.mode === 'script' && this.ring) {
      var ring = this.ring
      for (var k = 0; k < count; k++) {
        if (ring.available >= AUDIO_RING_FRAMES) break
        ring.left[ring.write] = samples[k * 2]
        ring.right[ring.write] = samples[k * 2 + 1]
        ring.write = (ring.write + 1) % AUDIO_RING_FRAMES
        ring.available++
      }
    }
  }

  AudioEngine.prototype.clear = function () {
    this.stagedFrames = 0
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'clear' })
      } catch (err) {
        /* ignore */
      }
    }
    if (this.ring) {
      this.ring.read = 0
      this.ring.write = 0
      this.ring.available = 0
    }
  }

  AudioEngine.prototype.setVolume = function (value) {
    this.volume = clampVolume(value)
    this._applyGain()
  }

  AudioEngine.prototype.setMuted = function (value) {
    this.muted = !!value
    this._applyGain()
  }

  AudioEngine.prototype.destroy = function () {
    if (this._destroyed) return
    this._destroyed = true
    this._wantAudio = false
    this._clearGestureUnlock()
    this.ready = false
    this.state = 'off'
    var ctx = this.ctx
    if (ctx && this._ctxStateHandler) {
      try {
        if (typeof ctx.removeEventListener === 'function') {
          ctx.removeEventListener('statechange', this._ctxStateHandler)
        } else if (ctx.onstatechange === this._ctxStateHandler) {
          ctx.onstatechange = null
        }
      } catch (err) {
        /* ignore */
      }
      this._ctxStateHandler = null
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null
        this.workletNode.disconnect()
      } catch (err) {
        /* ignore */
      }
      this.workletNode = null
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.onaudioprocess = null
        this.scriptNode.disconnect()
      } catch (err) {
        /* ignore */
      }
      this.scriptNode = null
    }
    if (this.gain) {
      try {
        this.gain.disconnect()
      } catch (err) {
        /* ignore */
      }
      this.gain = null
    }
    this.ring = null
    this.ctx = null
    if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
      try {
        var promise = ctx.close()
        if (promise && typeof promise.catch === 'function') promise.catch(noop)
      } catch (err) {
        /* ignore */
      }
    }
    if (this._blobUrl) {
      var URLCtor = root.URL || (typeof URL !== 'undefined' ? URL : null)
      try {
        if (URLCtor && typeof URLCtor.revokeObjectURL === 'function') URLCtor.revokeObjectURL(this._blobUrl)
      } catch (err) {
        /* ignore */
      }
      this._blobUrl = null
    }
  }

  // ---------------------------------------------------------------------------
  // Engine：帧循环、输入、存档、截图、状态上报
  // ---------------------------------------------------------------------------
  function Engine(jsnesLib, options) {
    if (!options || typeof options !== 'object') {
      throw makeError('GameBench: create() 需要一个 options 对象', 'BAD_OPTIONS')
    }
    var opts = options

    this._jsnes = jsnesLib
    this._onState = typeof opts.onState === 'function' ? opts.onState : null
    this._onError = typeof opts.onError === 'function' ? opts.onError : null

    this._ready = false
    this._destroyed = false
    this._started = false
    this._paused = false
    this._crashed = false
    this._hasRom = false
    this._pendingStart = false

    this._frames = 0
    this._fps = 0
    this._speed = normalizeSpeed(opts.speed)
    this._romTitle = ''
    this._romData = null

    this._rafId = null
    this._lastTickTs = null
    this._acc = 0
    this._statsWindowStart = null
    this._statsFrames = 0

    this._lastEmitted = null
    this._emitting = false
    this._emitPending = false

    this._buttonCodes = buildButtonCodes(jsnesLib.Controller)
    this._pressed = { 1: new Set(), 2: new Set() }

    var self = this

    // 1) 渲染器（缺 canvas / 无 ImageData 时抛可读错误）
    this._renderer = new Renderer(opts.canvas)
    this._snapshot = new SnapshotTaker(this._renderer)

    // 2) 音频（先建，才能把 AudioContext.sampleRate 传给 jsnes）
    this._audio = new AudioEngine({
      volume: opts.volume,
      muted: opts.muted,
      onStateChange: function () {
        if (self._ready) self._emitState(false)
      },
    })

    // 3) jsnes 实例（loadROM 会复用实例，reset() 后仍可继续）
    try {
      this._nes = new jsnesLib.NES({
        onFrame: function (frameBuffer) {
          if (!self._destroyed && self._renderer) self._renderer.draw(frameBuffer)
        },
        onAudioSample: function (left, right) {
          if (!self._destroyed) self._audio.push(left, right)
        },
        onStatusUpdate: noop,
        onBatteryRamWrite: noop,
        sampleRate: this._audio.sampleRate(),
        emulateSound: true,
      })
    } catch (err) {
      try {
        this._audio.destroy()
      } catch (err2) {
        /* ignore */
      }
      throw makeError('GameBench: 初始化 jSNES 失败', 'INIT_FAILED', err)
    }

    this.api = Object.freeze(this._buildApi())
    this._ready = true
    defer(function () {
      if (!self._destroyed) self._emitState(true)
    })
  }

  Engine.prototype._buildApi = function () {
    var self = this
    return {
      loadRom: function (data) {
        return self.loadRom(data)
      },
      start: function () {
        return self.start()
      },
      pause: function () {
        return self.pause()
      },
      resume: function () {
        return self.resume()
      },
      togglePause: function () {
        return self.togglePause()
      },
      reset: function () {
        return self.reset()
      },
      setButton: function (name, down, player) {
        return self.setButton(name, down, player)
      },
      releaseAll: function () {
        return self.releaseAll()
      },
      setVolume: function (value) {
        return self.setVolume(value)
      },
      setMuted: function (value) {
        return self.setMuted(value)
      },
      setSpeed: function (value) {
        return self.setSpeed(value)
      },
      saveState: function () {
        return self.saveState()
      },
      loadState: function (data) {
        return self.loadState(data)
      },
      snapshot: function () {
        return self.snapshot()
      },
      destroy: function () {
        return self.destroy()
      },
    }
  }

  // ---- 状态上报 -------------------------------------------------------------

  Engine.prototype._composeState = function () {
    return {
      running: !!(this._started && !this._paused && !this._crashed && !this._destroyed),
      paused: !!this._paused,
      crashed: !!this._crashed,
      audio: this._audio ? this._audio.state : 'off',
      fps: this._fps,
      frames: this._frames,
      romTitle: this._romTitle || '',
    }
  }

  Engine.prototype._emitState = function (force) {
    if (!this._ready) return
    var state = this._composeState()
    var prev = this._lastEmitted
    if (
      !force &&
      prev &&
      prev.running === state.running &&
      prev.paused === state.paused &&
      prev.crashed === state.crashed &&
      prev.audio === state.audio &&
      prev.romTitle === state.romTitle
    ) {
      return
    }
    this._lastEmitted = state
    if (!this._onState) return
    if (this._emitting) {
      this._emitPending = true
      return
    }
    this._emitting = true
    try {
      this._onState({
        running: state.running,
        paused: state.paused,
        crashed: state.crashed,
        audio: state.audio,
        fps: state.fps,
        frames: state.frames,
        romTitle: state.romTitle,
      })
    } catch (err) {
      debugLog('onState 回调抛错', err)
    } finally {
      this._emitting = false
      if (this._emitPending) {
        this._emitPending = false
        var self = this
        defer(function () {
          if (!self._destroyed) self._emitState(true)
        })
      }
    }
  }

  Engine.prototype._reportError = function (rawError, code) {
    var error
    if (rawError instanceof Error) error = rawError
    else error = new Error(String(rawError))
    try {
      if (code && !error.code) error.code = code
    } catch (err) {
      /* ignore */
    }
    if (!this._onError) return
    try {
      this._onError(error)
    } catch (err) {
      debugLog('onError 回调自身抛错', err)
    }
  }

  // ---- 帧循环 ---------------------------------------------------------------

  Engine.prototype._scheduleFrame = function () {
    if (this._rafId !== null) return
    if (this._destroyed || !this._started || this._paused || this._crashed) return
    var self = this
    this._rafId = requestFrame(function (timestamp) {
      self._rafId = null
      self._tick(timestamp)
    })
  }

  Engine.prototype._stopScheduler = function () {
    if (this._rafId !== null) {
      cancelFrame(this._rafId)
      this._rafId = null
    }
  }

  Engine.prototype._tick = function (timestamp) {
    if (this._destroyed || !this._started || this._paused || this._crashed) return
    var now = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : nowMs()
    if (this._lastTickTs === null) {
      this._lastTickTs = now
      this._acc = 0
      this._scheduleFrame()
      return
    }
    var delta = now - this._lastTickTs
    this._lastTickTs = now
    var frameMs = FRAME_MS / this._speed
    if (!(delta > 0)) delta = 0
    // 卡顿/后台恢复时不补一大串帧
    if (delta > frameMs * MAX_CATCHUP_FRAMES) delta = frameMs
    this._acc += delta

    var steps = 0
    while (this._acc >= frameMs && steps < MAX_CATCHUP_FRAMES) {
      this._acc -= frameMs
      if (!this._runOneFrame()) break
      steps++
    }
    if (this._acc > frameMs * MAX_CATCHUP_FRAMES) this._acc = 0

    if (this._crashed || this._destroyed) return
    this._updateStats(now)
    this._scheduleFrame()
  }

  Engine.prototype._runOneFrame = function () {
    try {
      this._nes.frame()
    } catch (err) {
      this._handleCrash(err)
      return false
    }
    this._frames++
    try {
      this._audio.flush(this._speed)
    } catch (err) {
      debugLog('音频 flush 失败', err)
    }
    if (this._nes.crashed) {
      this._handleCrash(makeError('GameBench: 模拟器进入崩溃状态', 'CRASH'))
      return false
    }
    return true
  }

  Engine.prototype._handleCrash = function (error) {
    if (this._crashed) return
    this._crashed = true
    // 保留 _started 意图：崩溃后 client 只需 reset()（再 render 层恢复播放状态）即可继续，
    // reset() 会清掉 crashed 并重新调度帧循环；是否“在跑”由 running 字段（含 crashed 判断）表达。
    this._paused = false
    this._stopScheduler()
    this._acc = 0
    this._lastTickTs = null
    try {
      this._audio.clear()
    } catch (err) {
      /* ignore */
    }
    this._emitState(true)
    this._reportError(error, 'CRASH')
  }

  Engine.prototype._updateStats = function (now) {
    this._statsFrames++
    if (this._statsWindowStart === null) {
      this._statsWindowStart = now
      return
    }
    var elapsed = now - this._statsWindowStart
    if (elapsed < FPS_WINDOW_MS) return
    var fps = (this._statsFrames * 1000) / elapsed
    this._statsFrames = 0
    this._statsWindowStart = now
    var rounded = Math.round(fps * 10) / 10
    if (rounded !== this._fps) this._fps = rounded
    // 低频状态上报（约 1 秒一次，绝不每帧触发）
    this._emitState(true)
  }

  // ---- 输入 -----------------------------------------------------------------

  // jsnes 2.1.0 的 NES.reset() 只会重建 CPU/PPU/PAPU 与 mapper 实例，却不会再调用
  // mapper.loadROM() 把 PRG/CHR 重新装入新实例（上游缺陷）：reset() 之后 CPU 会从
  // 未初始化的全 0 内存取指，导致 invalid opcode 崩溃。
  // 因此这里等价地使用「保留 ROM 数据重新 loadROM」来做软复位——RAM/CPU/PPU 都会重置，
  // 已加载的 ROM 也不会丢失。
  Engine.prototype._restartFromRetainedRom = function () {
    if (this._romData) {
      this._nes.loadROM(this._romData)
    } else {
      this._nes.reset()
    }
  }

  Engine.prototype._releaseAllButtons = function () {
    if (!this._nes) {
      this._pressed[1].clear()
      this._pressed[2].clear()
      return
    }
    var names = Object.keys(this._buttonCodes)
    for (var p = 1; p <= 2; p++) {
      for (var i = 0; i < names.length; i++) {
        var code = this._buttonCodes[names[i]]
        try {
          this._nes.buttonUp(p, code)
        } catch (err) {
          /* ignore */
        }
      }
      this._pressed[p].clear()
    }
  }

  Engine.prototype.setButton = function (name, down, player) {
    if (this._destroyed || !this._nes) return false
    var normalized = typeof name === 'string' ? name.toUpperCase() : ''
    if (!Object.prototype.hasOwnProperty.call(this._buttonCodes, normalized)) {
      debugLog('未知按键名，已忽略', name)
      return false
    }
    var controller = Number(player) === 2 ? 2 : 1
    var code = this._buttonCodes[normalized]
    var pressed = this._pressed[controller]
    var wanted = !!down
    if (wanted === pressed.has(code)) return true
    try {
      if (wanted) {
        this._nes.buttonDown(controller, code)
        pressed.add(code)
      } else {
        this._nes.buttonUp(controller, code)
        pressed.delete(code)
      }
    } catch (err) {
      debugLog('按键设置失败', err)
      return false
    }
    return true
  }

  Engine.prototype.releaseAll = function () {
    if (this._destroyed) return
    this._releaseAllButtons()
  }

  // ---- 生命周期 -------------------------------------------------------------

  Engine.prototype.loadRom = function (data) {
    if (this._destroyed) throw makeError('GameBench: engine 已销毁，无法加载 ROM', 'DESTROYED')
    var bytes
    try {
      bytes = toUint8Array(data)
    } catch (err) {
      throw err instanceof Error ? err : makeError('GameBench: ROM 数据类型无法识别', 'BAD_ROM')
    }
    if (bytes.length < 16) {
      throw makeError('GameBench: ROM 数据为空或过短', 'BAD_ROM')
    }
    if (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
      throw makeError('GameBench: 不是有效的 NES ROM（缺少 NES\\x1a 文件头）', 'BAD_ROM')
    }

    this._stopScheduler()
    this._acc = 0
    this._lastTickTs = null
    this._crashed = false
    this._releaseAllButtons()

    try {
      this._nes.loadROM(bytes)
    } catch (err) {
      var message = err && err.message ? err.message : String(err)
      throw makeError('GameBench: ROM 加载失败（' + message + '）', 'BAD_ROM', err)
    }

    this._romData = bytes
    this._hasRom = true
    this._romTitle = extractRomTitle(bytes)
    this._frames = 0
    this._fps = 0
    this._statsFrames = 0
    this._statsWindowStart = null
    if (this._renderer) this._renderer.clear()
    this._emitState(true)

    if (this._pendingStart) {
      this._pendingStart = false
      this.start()
    } else if (this._started && !this._paused) {
      this._scheduleFrame()
    }
    return true
  }

  Engine.prototype.start = function () {
    if (this._destroyed) return false
    if (!this._hasRom) {
      // 允许 client 先 start() 后 loadRom()：记下意图，loadRom 完成后自动开跑
      this._pendingStart = true
      return false
    }
    if (this._started && !this._paused && !this._crashed) {
      this._audio.start()
      return true
    }
    if (this._crashed) {
      this._crashed = false
      try {
        this._restartFromRetainedRom()
      } catch (err) {
        this._handleCrash(err)
        return false
      }
    }
    this._pendingStart = false
    this._started = true
    this._paused = false
    this._acc = 0
    this._lastTickTs = null
    this._statsFrames = 0
    this._statsWindowStart = null
    this._audio.start()
    // 立即同步渲染首帧：点击「开始」后画面马上出现，不必等第一个 rAF；
    // 同时让 start() 后的首次 onState 就带 frames=1（否则要等 1s 的低频上报）。
    if (!this._runOneFrame()) return false
    this._emitState(true)
    this._scheduleFrame()
    return true
  }

  Engine.prototype.pause = function () {
    if (this._destroyed) return false
    this._paused = true
    this._stopScheduler()
    this._acc = 0
    this._lastTickTs = null
    try {
      this._audio.clear()
    } catch (err) {
      /* ignore */
    }
    this._emitState(false)
    return true
  }

  Engine.prototype.resume = function () {
    if (this._destroyed) return false
    if (!this._started || this._crashed) return this.start()
    if (!this._paused) {
      this._audio.start()
      return true
    }
    this._paused = false
    this._acc = 0
    this._lastTickTs = null
    this._audio.start()
    this._emitState(true)
    this._scheduleFrame()
    return true
  }

  Engine.prototype.togglePause = function () {
    if (this._destroyed) return false
    if (this._paused || !this._started || this._crashed) return this.resume()
    return this.pause()
  }

  Engine.prototype.reset = function () {
    if (this._destroyed || !this._hasRom) return false
    this._stopScheduler()
    this._acc = 0
    this._lastTickTs = null
    this._crashed = false
    try {
      this._restartFromRetainedRom()
    } catch (err) {
      this._handleCrash(err)
      return false
    }
    this._releaseAllButtons()
    try {
      this._audio.clear()
    } catch (err) {
      /* ignore */
    }
    if (this._renderer) this._renderer.clear()
    this._emitState(true)
    if (this._started && !this._paused) this._scheduleFrame()
    return true
  }

  Engine.prototype.setVolume = function (value) {
    if (this._destroyed) return
    this._audio.setVolume(value)
  }

  Engine.prototype.setMuted = function (value) {
    if (this._destroyed) return
    this._audio.setMuted(value)
  }

  Engine.prototype.setSpeed = function (value) {
    if (this._destroyed) return
    this._speed = normalizeSpeed(value)
    this._acc = 0
    this._lastTickTs = null
  }

  // ---- 存档 -----------------------------------------------------------------

  Engine.prototype.saveState = function () {
    if (this._destroyed) {
      return Promise.reject(makeError('GameBench: engine 已销毁，无法保存存档', 'DESTROYED'))
    }
    if (!this._hasRom) {
      return Promise.reject(makeError('GameBench: 尚未加载 ROM，无法保存存档', 'NO_ROM'))
    }
    var json
    try {
      json = JSON.stringify(this._nes.toJSON())
    } catch (err) {
      return Promise.reject(makeError('GameBench: 存档序列化失败', 'SAVE_FAILED', err))
    }
    var raw
    try {
      raw = utf8Encode(json)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : makeError('GameBench: 存档编码失败', 'SAVE_FAILED'))
    }
    return gzipBytes(raw).catch(function (err) {
      // 无 CompressionStream 或压缩异常 → 返回裸 JSON 字节（loadState 能识别）
      debugLog('gzip 压缩不可用，返回未压缩存档', err)
      return raw
    })
  }

  Engine.prototype.loadState = function (data) {
    var self = this
    if (this._destroyed) {
      return Promise.reject(makeError('GameBench: engine 已销毁，无法读取存档', 'DESTROYED'))
    }
    if (!this._hasRom) {
      return Promise.reject(makeError('GameBench: 请先加载 ROM 再读取存档', 'NO_ROM'))
    }
    var bytes
    try {
      bytes = toUint8Array(data)
    } catch (err) {
      return Promise.reject(makeError('GameBench: 存档数据类型无法识别', 'BAD_STATE', err))
    }
    if (!bytes || bytes.length === 0) {
      return Promise.reject(makeError('GameBench: 存档为空', 'BAD_STATE'))
    }

    var wasRunning = this._started && !this._paused && !this._crashed
    this._stopScheduler()

    var rawPromise =
      bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipBytes(bytes).catch(function (err) {
            throw makeError('GameBench: 存档解压失败', 'BAD_STATE', err)
          })
        : Promise.resolve(bytes)

    return rawPromise
      .then(function (raw) {
        var parsed
        try {
          parsed = JSON.parse(utf8Decode(raw))
        } catch (err) {
          throw makeError('GameBench: 存档内容不是有效的 JSON', 'BAD_STATE', err)
        }
        try {
          // 契约：先重置再由 fromJSON 覆盖（fromJSON 内部也会 reset）。
          // 这里用“保留 ROM 重新 loadROM”做干净重置，规避 jsnes 2.1.0 reset() 不重装 mapper 的缺陷。
          self._restartFromRetainedRom()
          self._nes.fromJSON(parsed)
        } catch (err) {
          // 失败回滚到可玩状态，避免把模拟器留在半坏状态
          try {
            self._restartFromRetainedRom()
          } catch (rollbackError) {
            debugLog('读档失败后回滚也失败', rollbackError)
          }
          throw makeError('GameBench: 存档无法载入（可能不属于当前 ROM）', 'BAD_STATE', err)
        }
        self._crashed = false
        self._releaseAllButtons()
        try {
          self._audio.clear()
        } catch (err) {
          /* ignore */
        }
        if (self._renderer) self._renderer.clear()
        self._acc = 0
        self._lastTickTs = null
        self._emitState(true)
        if (wasRunning && self._started && !self._paused && !self._destroyed) {
          self._scheduleFrame()
        }
      })
      .catch(function (err) {
        // 失败时不改状态；如果之前正在跑，恢复调度
        if (wasRunning && self._started && !self._paused && !self._destroyed && !self._crashed) {
          self._scheduleFrame()
        }
        throw err instanceof Error ? err : makeError('GameBench: 读取存档失败', 'BAD_STATE', err)
      })
  }

  // ---- 截图 / 销毁 ----------------------------------------------------------

  Engine.prototype.snapshot = function () {
    if (this._destroyed || !this._snapshot) return ''
    return this._snapshot.capture()
  }

  Engine.prototype.destroy = function () {
    if (this._destroyed) return
    this._stopScheduler()
    this._started = false
    this._paused = true
    this._acc = 0
    this._lastTickTs = null
    try {
      this._releaseAllButtons()
    } catch (err) {
      /* ignore */
    }
    try {
      this._audio.destroy()
    } catch (err) {
      debugLog('音频销毁异常', err)
    }
    this._destroyed = true
    // 最后一次性状态（running:false / paused:true / audio:'off'）
    this._emitState(true)
    this._onState = null
    this._onError = null
    this._nes = null
    this._romData = null
    this._renderer = null
    this._snapshot = null
  }

  // ---------------------------------------------------------------------------
  // 对外入口
  // ---------------------------------------------------------------------------
  root.__GAME_BENCH_ENGINE_VERSION__ = ENGINE_VERSION

  function create(options) {
    var jsnesLib = root.jsnes
    if (!jsnesLib || typeof jsnesLib.NES !== 'function') {
      throw makeError(
        'GameBench: jsnes 运行时未加载（应先加载 /game-bench/api/vendor/jsnes.js）',
        'NO_JSNES',
      )
    }
    var engine = new Engine(jsnesLib, options)
    return engine.api
  }

  root.GameBenchCore = {
    create: create,
  }

  debugLog('engine 已加载，版本', ENGINE_VERSION)
})()
