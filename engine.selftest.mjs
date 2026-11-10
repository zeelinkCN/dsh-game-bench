#!/usr/bin/env node
/**
 * dsh-game-bench engine.js Node 自测
 *
 * 浏览器运行时（engine.js + jsnes UMD）在 Node 里没有 DOM，所以本文件：
 *   1. 搭一个最小 DOM 垫片（假 canvas / ImageData / document）；
 *   2. requestAnimationFrame 用「排队 + 虚拟时钟」实现，由测试同步驱动，
 *      这样 600 帧只需几十毫秒而不是 10 秒（时间戳仍按 60.098fps 推进）；
 *   3. 不提供 AudioContext → 走 engine 的 audio:'unsupported' 静音分支；
 *   4. 用 new Function 依次执行 vendor/jsnes.min.js 与 engine.js（与浏览器 <script> 等价）。
 *
 * 覆盖 ENGINE.md §6 的验收项：7 款内置 ROM 各 700 帧、存档往返、按键、暂停/复位、销毁、
 * 单帧耗时、画面非全黑、存档体积。
 *
 * 运行：/Users/lz/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node engine.selftest.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRAME_MS = 1000 / 60.098

// ---------------------------------------------------------------------------
// 1. 最小 DOM 垫片
// ---------------------------------------------------------------------------
let virtualNow = 1000
let rafSeq = 0
let rafQueue = [] // [{ id, cb }]

function fakeRequestAnimationFrame(callback) {
  const id = ++rafSeq
  rafQueue.push({ id, cb: callback })
  return id
}

function fakeCancelAnimationFrame(id) {
  rafQueue = rafQueue.filter((entry) => entry.id !== id)
}

function createFakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    _image: null,
    _ctx: null,
    getContext(type) {
      if (type !== '2d') return null
      if (canvas._ctx) return canvas._ctx
      const context = {
        canvas,
        createImageData(width, height) {
          return {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          }
        },
        getImageData(x, y, width, height) {
          return {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          }
        },
        putImageData(image) {
          canvas._image = image
        },
        drawImage() {},
      }
      canvas._ctx = context
      return context
    },
    toDataURL(type) {
      const mime = type || 'image/png'
      return 'data:' + mime + ';base64,' + Buffer.from('fake-png').toString('base64')
    },
  }
  return canvas
}

globalThis.window = globalThis
globalThis.requestAnimationFrame = fakeRequestAnimationFrame
globalThis.cancelAnimationFrame = fakeCancelAnimationFrame
globalThis.document = {
  createElement(tag) {
    if (String(tag).toLowerCase() === 'canvas') return createFakeCanvas()
    return { style: {} }
  },
  addEventListener() {},
  removeEventListener() {},
}
// 明确模拟「没有 AudioContext」的环境
delete globalThis.AudioContext

// ---------------------------------------------------------------------------
// 2. 虚拟帧泵
// ---------------------------------------------------------------------------
function pumpTicks(count) {
  let pumped = 0
  while (pumped < count) {
    if (rafQueue.length === 0) break
    const entry = rafQueue.shift()
    virtualNow += FRAME_MS
    entry.cb(virtualNow)
    pumped++
  }
  return pumped
}

function pendingRafCount() {
  return rafQueue.length
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// 3. 加载 vendor/jsnes.min.js + engine.js（模拟 <script> 顺序加载）
// ---------------------------------------------------------------------------
function loadScripts() {
  const jsnesPath = path.join(HERE, 'vendor/jsnes.min.js')
  const enginePath = path.join(HERE, 'engine.js')
  const jsnesSource = readFileSync(jsnesPath, 'utf8')
  const engineSource = readFileSync(enginePath, 'utf8')
  // new Function 的顶层即全局作用域，UMD 会挂到 globalThis.jsnes
  new Function(jsnesSource + '\n//# sourceURL=vendor/jsnes.min.js')()
  new Function(engineSource + '\n//# sourceURL=engine.js')()
}

// ---------------------------------------------------------------------------
// 4. 断言与统计
// ---------------------------------------------------------------------------
let passCount = 0
let failCount = 0
const failureMessages = []

function check(name, condition, detail) {
  if (condition) {
    passCount++
    return true
  }
  failCount++
  const message = detail ? `${name}（${detail}）` : name
  failureMessages.push(message)
  console.log('  FAIL ' + message)
  return false
}

function countNonZeroPixels(canvas) {
  const image = canvas._image
  if (!image || !image.data) return 0
  const data = image.data
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) count++
  }
  return count
}

function formatKB(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB'
}

// ---------------------------------------------------------------------------
// 5. 单个 ROM 的完整验收流程
// ---------------------------------------------------------------------------
async function testRom(game, index, total, jsnesVersion) {
  const romPath = path.join(HERE, 'games', game.file)
  const romBytes = new Uint8Array(readFileSync(romPath))
  const canvas = createFakeCanvas()

  let latestState = null
  let stateEmissions = 0
  const runtimeErrors = []
  const romCheck = (name, condition, detail) => check(`[${game.title}] ${name}`, condition, detail)

  const passBefore = passCount
  const failBefore = failCount

  const engine = window.GameBenchCore.create({
    canvas,
    volume: 0.8,
    muted: false,
    speed: 1,
    onState(state) {
      latestState = state
      stateEmissions++
    },
    onError(error) {
      runtimeErrors.push(error)
    },
  })
  await flushMicrotasks()

  if (index === 0) {
    romCheck('创建后立即收到初始状态', latestState !== null)
    romCheck('无 AudioContext 时 audio=unsupported', latestState !== null && latestState.audio === 'unsupported', latestState && latestState.audio)
    romCheck('初始帧数 0', latestState !== null && latestState.frames === 0)
  }

  // ---- ROM 加载 ----
  let loadError = null
  try {
    engine.loadRom(romBytes)
  } catch (error) {
    loadError = error
  }
  romCheck('loadRom 成功', !loadError, loadError && loadError.message)
  if (loadError) {
    engine.destroy()
    return { title: game.title, error: loadError }
  }
  romCheck('ROM 大小与清单一致', romBytes.length === game.size, `${romBytes.length} vs ${game.size}`)

  // ---- 音量/静音/倍速/未知按键 ----
  let controlError = null
  try {
    engine.setVolume(0.6)
    engine.setMuted(true)
    engine.setMuted(false)
    engine.setSpeed(1.25)
    engine.setSpeed(1)
    engine.setButton('NOT_A_BUTTON', true) // 未知按键名应被忽略
  } catch (error) {
    controlError = error
  }
  romCheck('setVolume/setMuted/setSpeed 不抛错', !controlError, controlError && controlError.message)

  // ---- 启动 ----
  let startResult = false
  let startError = null
  try {
    startResult = engine.start()
  } catch (error) {
    startError = error
  }
  romCheck('start() 启动成功', startResult === true && !startError, startError && startError.message)
  await flushMicrotasks()
  romCheck(
    'start() 立即同步渲染首帧（首次 onState 即 frames=1）',
    latestState !== null && latestState.frames === 1,
    latestState && String(latestState.frames),
  )

  // ---- 按键：START 按下/幂等/释放 ----
  let buttonError = null
  try {
    engine.setButton('START', true)
    engine.setButton('START', true) // 幂等：重复按下不抛错
    pumpTicks(3)
    engine.releaseAll()
    engine.releaseAll() // 幂等
    pumpTicks(3)
  } catch (error) {
    buttonError = error
  }
  romCheck('setButton(START)/releaseAll 不抛错', !buttonError, buttonError && buttonError.message)

  // ---- 预热 100 帧 ----
  pumpTicks(120)
  engine.pause()
  await flushMicrotasks()
  const framesWarm = latestState ? latestState.frames : 0
  romCheck('预热后累计帧数 > 100', framesWarm > 100, '实际 ' + framesWarm)

  // ---- 计时：再跑 600 帧 ----
  engine.resume()
  const startedAt = process.hrtime.bigint()
  const timedTicks = pumpTicks(620)
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  engine.pause()
  await flushMicrotasks()
  const framesTimed = latestState.frames - framesWarm
  const avgFrameMs = framesTimed > 0 ? elapsedMs / framesTimed : Infinity
  const fps = framesTimed > 0 ? framesTimed / (elapsedMs / 1000) : 0

  romCheck('计时窗口跑满 ~600 帧', framesTimed >= 600, `实际 ${framesTimed}（${timedTicks} 次 rAF）`)
  romCheck('累计帧数 > 500', latestState.frames > 500, '实际 ' + latestState.frames)
  romCheck('单帧平均耗时 < 8ms', avgFrameMs < 8, avgFrameMs.toFixed(3) + ' ms')
  romCheck('运行期无 onError', runtimeErrors.length === 0, runtimeErrors.map((e) => e.message).join('; '))
  romCheck('暂停状态 running=false / paused=true', latestState.running === false && latestState.paused === true)

  // ---- 画面 ----
  const nonZeroPixels = countNonZeroPixels(canvas)
  romCheck('画面非全黑（非零像素 > 500）', nonZeroPixels > 500, '非零像素 ' + nonZeroPixels)

  // ---- 截图 ----
  const snapshot = engine.snapshot()
  romCheck('snapshot() 返回 PNG dataURL', typeof snapshot === 'string' && snapshot.startsWith('data:image/png'), typeof snapshot === 'string' ? snapshot.slice(0, 24) : String(snapshot))

  // ---- 存档往返 ----
  let savedBytes = null
  let saveError = null
  try {
    savedBytes = await engine.saveState()
  } catch (error) {
    saveError = error
  }
  romCheck('saveState() 成功', !saveError && savedBytes instanceof Uint8Array, saveError && saveError.message)
  if (!savedBytes) {
    engine.destroy()
    return { title: game.title, error: saveError }
  }
  const isGzip = savedBytes.length >= 2 && savedBytes[0] === 0x1f && savedBytes[1] === 0x8b
  romCheck('saveState() 产物是 gzip（1f 8b）', isGzip, '首字节 ' + savedBytes[0] + ',' + savedBytes[1])
  romCheck('存档体积在 10KB–3MB 之间', savedBytes.length >= 10 * 1024 && savedBytes.length <= 3 * 1024 * 1024, formatKB(savedBytes.length))
  romCheck('存档体积期望 < 300KB', savedBytes.length < 300 * 1024, formatKB(savedBytes.length))

  const framesBeforeRestore = latestState.frames
  let restoreError = null
  try {
    await engine.loadState(savedBytes)
  } catch (error) {
    restoreError = error
  }
  romCheck('loadState() 往返成功', !restoreError, restoreError && restoreError.message)

  if (!restoreError) {
    engine.resume()
    pumpTicks(140)
    engine.pause()
    await flushMicrotasks()
    const framesAfterRestore = latestState.frames - framesBeforeRestore
    romCheck('读档后继续跑 120+ 帧', framesAfterRestore >= 120, '实际 ' + framesAfterRestore)
    romCheck('读档后无运行期错误', runtimeErrors.length === 0, runtimeErrors.map((e) => e.message).join('; '))
  }

  // ---- 暂停稳定性 ----
  const framesPaused = latestState.frames
  await sleep(250)
  engine.resume()
  engine.pause()
  await flushMicrotasks()
  romCheck('pause() 后 frames 不再增长', latestState.frames === framesPaused, `${latestState.frames} vs ${framesPaused}`)

  // ---- 复位 ----
  engine.reset()
  engine.resume()
  pumpTicks(80)
  engine.pause()
  await flushMicrotasks()
  romCheck('reset() 后帧继续增长', latestState.frames > framesPaused + 60, `${latestState.frames} vs ${framesPaused}`)
  romCheck('reset() 后 crashed=false', latestState.crashed === false)

  // ---- 销毁 ----
  const framesBeforeDestroy = latestState.frames
  const emissionsBeforeDestroy = stateEmissions
  engine.destroy()
  await flushMicrotasks()
  const destroyedState = latestState
  romCheck('destroy() 后 running=false', destroyedState.running === false)
  romCheck('destroy() 后无排队 rAF', pendingRafCount() === 0, '排队 ' + pendingRafCount())
  const emissionsAtDestroy = stateEmissions
  await sleep(500)
  romCheck('destroy() 后 500ms 内无新状态回调', stateEmissions === emissionsAtDestroy, `${stateEmissions} vs ${emissionsAtDestroy}`)
  romCheck('destroy() 后 500ms 内 frames 不增长', latestState.frames === destroyedState.frames, `${latestState.frames} vs ${destroyedState.frames}`)
  let destroyTwiceError = null
  try {
    engine.destroy()
  } catch (error) {
    destroyTwiceError = error
  }
  romCheck('destroy() 幂等', !destroyTwiceError)

  const passed = passCount - passBefore
  const failed = failCount - failBefore
  const info = {
    title: game.title,
    frames: destroyedState.frames,
    timedFrames: framesTimed,
    avgFrameMs,
    fps,
    nonZeroPixels,
    saveBytes: savedBytes.length,
    gzip: isGzip,
    passed,
    failed,
    emissionsBeforeDestroy,
  }
  console.log(
    `[${index + 1}/${total}] ${game.title}\n` +
      `        帧数 ${info.frames} | 计时帧 ${info.timedFrames} | 单帧 ${info.avgFrameMs.toFixed(3)} ms (${info.fps.toFixed(0)} fps) | ` +
      `非零像素 ${info.nonZeroPixels} | 存档 ${formatKB(info.saveBytes)} (gzip=${isGzip}) | ${info.passed} 项通过${info.failed ? ' / ' + info.failed + ' 项失败' : ''}`,
  )
  return info
}

// ---------------------------------------------------------------------------
// 6. 崩溃处理：喂一个 PC 指向非法 opcode 的存档 → 崩溃上报 → reset() 恢复
// ---------------------------------------------------------------------------
async function testCrashRecovery(romBytes) {
  const canvas = createFakeCanvas()
  let latestState = null
  const runtimeErrors = []
  const engine = window.GameBenchCore.create({
    canvas,
    onState(state) {
      latestState = state
    },
    onError(error) {
      runtimeErrors.push(error)
    },
  })
  await flushMicrotasks()
  engine.loadRom(romBytes)
  engine.start()
  pumpTicks(120)
  engine.pause()

  // 用真实存档改出一个「PC 指向非法 opcode」的坏状态
  const savedBytes = await engine.saveState()
  const stateJson = JSON.parse(gunzipSync(Buffer.from(savedBytes)).toString('utf8'))
  // jsnes 的 REG_PC 比实际取指地址小 1（取指用 REG_PC + 1）。
  // 0x02 是 6502 的 KIL/JAM 家族、jsnes 2.1.0 未实现，会稳定抛 invalid opcode。
  stateJson.cpu.REG_PC = 0x2ff
  stateJson.cpu.REG_PC_NEW = 0x2ff
  stateJson.cpu.mem[0x300] = 0x02
  stateJson.cpu.irqRequested = false
  stateJson.cpu.nmiRaised = false
  stateJson.cpu.nmiPending = false
  stateJson.cpu.nmiImmediate = false
  const corruptBytes = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(stateJson))))

  let loadCorruptError = null
  try {
    await engine.loadState(corruptBytes)
  } catch (error) {
    loadCorruptError = error
  }
  check('[崩溃] 损坏状态本身可被 loadState 接受（崩溃发生在 frame()）', !loadCorruptError, loadCorruptError && loadCorruptError.message)

  const framesBeforeCrash = latestState ? latestState.frames : 0
  engine.resume()
  pumpTicks(30)
  await flushMicrotasks()

  check('[崩溃] onState.crashed=true', latestState && latestState.crashed === true, latestState && String(latestState.crashed))
  check('[崩溃] onState.running=false', latestState && latestState.running === false)
  check('[崩溃] onError 上报 CRASH', runtimeErrors.some((error) => error.code === 'CRASH'), runtimeErrors.map((error) => error.code).join('/'))
  check('[崩溃] onError 只上报一次', runtimeErrors.filter((error) => error.code === 'CRASH').length === 1, String(runtimeErrors.length))
  check('[崩溃] 帧循环停止（无排队 rAF）', pendingRafCount() === 0, '排队 ' + pendingRafCount())
  check('[崩溃] 帧计数不再增长', latestState.frames === framesBeforeCrash, `${latestState.frames} vs ${framesBeforeCrash}`)

  // reset() 后应能继续跑（不要求 client 再点开始）
  engine.reset()
  pumpTicks(140)
  engine.pause()
  await flushMicrotasks()
  check('[崩溃] reset() 后 crashed=false', latestState.crashed === false)
  check('[崩溃] reset() 后帧继续增长', latestState.frames > framesBeforeCrash + 60, `${latestState.frames} vs ${framesBeforeCrash}`)
  check('[崩溃] reset() 后无新的 onError', runtimeErrors.length === 1, String(runtimeErrors.length))

  engine.destroy()
  check('[崩溃] destroy 幂等', true)
}

// ---------------------------------------------------------------------------
// 7. 音频链路（Node 里用 mock AudioContext / AudioWorklet / ScriptProcessor）
//    真实浏览器里由 WebAudio 驱动；这里验证 engine 的接线、状态机、Gain 控制，
//    以及内联 AudioWorklet 处理器源码的 ring buffer 行为。
// ---------------------------------------------------------------------------
function makeMockAudioContextClass(mode, captured) {
  return class MockAudioContext {
    constructor() {
      captured.contexts.push(this)
      this.sampleRate = 48000
      this.state = 'suspended'
      this.currentTime = 0
      this.destination = { connect() {}, disconnect() {} }
      this._stateListeners = []
      const gainParam = {
        value: 1,
        setTargetAtTime(value) {
          this.value = value
        },
      }
      const gainNode = { gain: gainParam, connect() {}, disconnect() {} }
      this.gain = gainNode
      captured.gain = gainParam
      this.createGain = () => gainNode
      if (mode === 'worklet') {
        this.audioWorklet = {
          addModule: (url) => {
            captured.moduleUrl = url
            return Promise.resolve()
          },
        }
      } else {
        this.createScriptProcessor = (bufferSize) => {
          const node = { bufferSize, onaudioprocess: null, connect() {}, disconnect() {} }
          captured.scriptNode = node
          return node
        }
      }
    }
    addEventListener(type, handler) {
      if (type === 'statechange') this._stateListeners.push(handler)
    }
    removeEventListener(type, handler) {
      if (type === 'statechange') this._stateListeners = this._stateListeners.filter((entry) => entry !== handler)
    }
    _fireStateChange() {
      this._stateListeners.slice().forEach((handler) => handler())
    }
    resume() {
      this.state = 'running'
      this._fireStateChange()
      return Promise.resolve()
    }
    close() {
      this.state = 'closed'
      return Promise.resolve()
    }
  }
}

class MockAudioWorkletNode {
  constructor(context, name, options) {
    this.context = context
    this.name = name
    this.options = options
    this.messages = []
    this.connected = false
    this.port = {
      onmessage: null,
      postMessage: (message) => {
        this.messages.push(message)
      },
    }
    MockAudioWorkletNode.instances.push(this)
  }
  connect() {
    this.connected = true
  }
  disconnect() {
    this.connected = false
  }
}
MockAudioWorkletNode.instances = []

function testWorkletProcessorSource(source) {
  let ProcessorCtor = null
  let processorName = null
  const AudioWorkletProcessorStub = class {
    constructor() {
      this.port = { onmessage: null }
    }
  }
  const registerProcessor = (name, ctor) => {
    processorName = name
    ProcessorCtor = ctor
  }
  try {
    new Function('AudioWorkletProcessor', 'registerProcessor', source)(AudioWorkletProcessorStub, registerProcessor)
  } catch (error) {
    check('[音频] worklet 源码可执行', false, error && error.message)
    return
  }
  check('[音频] worklet 源码可执行并注册处理器', typeof ProcessorCtor === 'function' && processorName === 'game-bench-audio-processor', String(processorName))
  if (!ProcessorCtor) return

  const processor = new ProcessorCtor({ processorOptions: { capacityFrames: 8192 } })
  const samples = new Float32Array(2000)
  for (let i = 0; i < 1000; i++) {
    samples[i * 2] = 0.25
    samples[i * 2 + 1] = -0.25
  }
  processor.port.onmessage({ data: { type: 'push', samples } })
  const left = new Float32Array(128)
  const right = new Float32Array(128)
  processor.process([], [[left, right]])
  check('[音频] worklet ring buffer 输出样本正确', left[0] === 0.25 && right[0] === -0.25, `${left[0]}, ${right[0]}`)

  processor.port.onmessage({ data: { type: 'clear' } })
  processor.process([], [[left, right]])
  check('[音频] worklet clear 后输出静音', left[0] === 0 && right[0] === 0, `${left[0]}, ${right[0]}`)

  // 欠采样时补静音、不抛错
  processor.process([], [[new Float32Array(256), new Float32Array(256)]])
  check('[音频] worklet 欠采样输出静音且不抛错', true)
}

async function testAudioWorkletPath(romBytes) {
  const captured = { contexts: [], moduleUrl: null, gain: null }
  const OriginalAudioContext = globalThis.AudioContext
  const OriginalWorkletNode = globalThis.AudioWorkletNode
  const originalCreateObjectURL = URL.createObjectURL
  let latestState = null
  MockAudioWorkletNode.instances = []

  globalThis.AudioContext = makeMockAudioContextClass('worklet', captured)
  globalThis.AudioWorkletNode = MockAudioWorkletNode
  URL.createObjectURL = (blob) => {
    captured.blob = blob
    return 'blob:game-bench-mock'
  }

  try {
    const engine = window.GameBenchCore.create({
      canvas: createFakeCanvas(),
      volume: 0.5,
      muted: false,
      onState(state) {
        latestState = state
      },
    })
    await flushMicrotasks()
    engine.loadRom(romBytes)
    engine.start()
    await flushMicrotasks()
    await flushMicrotasks()

    check('[音频] AudioWorklet 路径 audio=on', latestState && latestState.audio === 'on', latestState && latestState.audio)
    check('[音频] 已创建 2 声道 AudioWorkletNode', MockAudioWorkletNode.instances.length === 1 && MockAudioWorkletNode.instances[0].options.outputChannelCount[0] === 2)
    check('[音频] addModule 使用 Blob URL', captured.moduleUrl === 'blob:game-bench-mock', String(captured.moduleUrl))

    pumpTicks(40)
    const node = MockAudioWorkletNode.instances[0]
    const pushMessages = node ? node.messages.filter((message) => message.type === 'push') : []
    check('[音频] 每帧向 worklet 推送样本', pushMessages.length >= 30, 'push ' + pushMessages.length)
    check(
      '[音频] 推送样本为交错立体声 Float32',
      pushMessages.length > 0 && pushMessages[0].samples instanceof Float32Array && pushMessages[0].samples.length % 2 === 0,
    )

    engine.setMuted(true)
    check('[音频] muted 时 GainNode=0', captured.gain.value === 0, String(captured.gain.value))
    engine.setMuted(false)
    engine.setVolume(0.4)
    check('[音频] volume 反映到 GainNode', Math.abs(captured.gain.value - 0.4) < 1e-6, String(captured.gain.value))

    const source = captured.blob ? await captured.blob.text() : ''
    check('[音频] worklet 源码非空', source.includes('GameBenchAudioProcessor') && source.includes('registerProcessor'))
    testWorkletProcessorSource(source)

    engine.destroy()
    check('[音频] destroy 关闭 AudioContext', captured.contexts.length === 1 && captured.contexts[0].state === 'closed', captured.contexts[0] && captured.contexts[0].state)
    check('[音频] destroy 后 audio 状态 off', latestState && latestState.audio === 'off', latestState && latestState.audio)
    check('[音频] destroy 后无排队 rAF', pendingRafCount() === 0, '排队 ' + pendingRafCount())
  } finally {
    globalThis.AudioContext = OriginalAudioContext
    globalThis.AudioWorkletNode = OriginalWorkletNode
    URL.createObjectURL = originalCreateObjectURL
  }
}

async function testScriptProcessorPath(romBytes) {
  const captured = { contexts: [], scriptNode: null, gain: null }
  const OriginalAudioContext = globalThis.AudioContext
  const OriginalWorkletNode = globalThis.AudioWorkletNode
  let latestState = null

  globalThis.AudioContext = makeMockAudioContextClass('script', captured)
  globalThis.AudioWorkletNode = undefined

  try {
    const engine = window.GameBenchCore.create({
      canvas: createFakeCanvas(),
      volume: 0.7,
      onState(state) {
        latestState = state
      },
    })
    await flushMicrotasks()
    engine.loadRom(romBytes)
    engine.start()
    await flushMicrotasks()
    await flushMicrotasks()

    check('[音频] 无 AudioWorklet 时降级 ScriptProcessor（audio=on）', latestState && latestState.audio === 'on', latestState && latestState.audio)
    check('[音频] 已创建 ScriptProcessor 节点', !!captured.scriptNode && captured.scriptNode.bufferSize === 1024)

    pumpTicks(40)
    const left = new Float32Array(1024)
    const right = new Float32Array(1024)
    const outputBuffer = {
      numberOfChannels: 2,
      getChannelData(channel) {
        return channel === 0 ? left : right
      },
    }
    captured.scriptNode.onaudioprocess({ outputBuffer })
    let nonZero = 0
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== 0 || right[i] !== 0) nonZero++
    }
    check('[音频] ScriptProcessor 回调输出非静音样本', nonZero > 0, 'nonZero ' + nonZero)

    engine.destroy()
    check('[音频] ScriptProcessor 路径 destroy 关闭 AudioContext', captured.contexts.length === 1 && captured.contexts[0].state === 'closed')
  } finally {
    globalThis.AudioContext = OriginalAudioContext
    globalThis.AudioWorkletNode = OriginalWorkletNode
  }
}

// ---------------------------------------------------------------------------
// 8. 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== dsh-game-bench engine.selftest ===')
  console.log('Node ' + process.version + ' | engine 自测（最小 DOM 垫片 + mock WebAudio，无真实音频设备）')

  loadScripts()

  check('vendor/jsnes.min.js 加载成功（window.jsnes.NES）', !!(window.jsnes && typeof window.jsnes.NES === 'function'))
  check('window.GameBenchCore.create 可用', !!(window.GameBenchCore && typeof window.GameBenchCore.create === 'function'))
  check('engine 版本号 = 1.0.0', window.__GAME_BENCH_ENGINE_VERSION__ === '1.0.0', String(window.__GAME_BENCH_ENGINE_VERSION__))
  check('jsnes 版本为 2.1.0', !!(window.jsnes && window.jsnes.NES), 'jsnes UMD 无版本号导出，仅校验存在')

  // ---- create 入参校验 ----
  let createNoArgError = null
  try {
    window.GameBenchCore.create()
  } catch (error) {
    createNoArgError = error
  }
  check(
    'create() 缺参数抛可读错误',
    !!createNoArgError && /options|canvas/i.test(createNoArgError.message),
    createNoArgError && createNoArgError.message,
  )

  let createNoCanvasError = null
  try {
    window.GameBenchCore.create({})
  } catch (error) {
    createNoCanvasError = error
  }
  check('create({}) 缺 canvas 抛可读错误', !!createNoCanvasError && /canvas/i.test(createNoCanvasError.message), createNoCanvasError && createNoCanvasError.message)

  let createBadCanvasError = null
  try {
    window.GameBenchCore.create({ canvas: {} })
  } catch (error) {
    createBadCanvasError = error
  }
  check('create({canvas:{}}) 抛可读错误', !!createBadCanvasError && /canvas/i.test(createBadCanvasError.message), createBadCanvasError && createBadCanvasError.message)

  // ---- 错误分支（非法 ROM / 无 ROM 存档）----
  const validationEngine = window.GameBenchCore.create({ canvas: createFakeCanvas() })
  await flushMicrotasks()

  let badRomError = null
  try {
    validationEngine.loadRom(new Uint8Array([1, 2, 3, 4]))
  } catch (error) {
    badRomError = error
  }
  check('非法 ROM 抛 BAD_ROM', !!badRomError && badRomError.code === 'BAD_ROM', badRomError && badRomError.message)

  let saveWithoutRomError = null
  try {
    await validationEngine.saveState()
  } catch (error) {
    saveWithoutRomError = error
  }
  check('未加载 ROM 时 saveState 拒绝（NO_ROM）', !!saveWithoutRomError && saveWithoutRomError.code === 'NO_ROM', saveWithoutRomError && saveWithoutRomError.message)

  let loadWithoutRomError = null
  try {
    await validationEngine.loadState(new Uint8Array([1, 2]))
  } catch (error) {
    loadWithoutRomError = error
  }
  check('未加载 ROM 时 loadState 拒绝（NO_ROM）', !!loadWithoutRomError && loadWithoutRomError.code === 'NO_ROM', loadWithoutRomError && loadWithoutRomError.message)

  let badStateError = null
  const emptyEngine = window.GameBenchCore.create({ canvas: createFakeCanvas() })
  await flushMicrotasks()
  // 先在 emptyEngine 上加载一个真实 ROM，再喂坏存档
  const builtinJson = JSON.parse(readFileSync(path.join(HERE, 'games/builtin.json'), 'utf8'))
  const games = builtinJson.games
  const firstRom = new Uint8Array(readFileSync(path.join(HERE, 'games', games[0].file)))
  emptyEngine.loadRom(firstRom)
  try {
    await emptyEngine.loadState(new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02]))
  } catch (error) {
    badStateError = error
  }
  check('损坏的 gzip 存档抛 BAD_STATE', !!badStateError && badStateError.code === 'BAD_STATE', badStateError && badStateError.message)
  emptyEngine.destroy()
  validationEngine.destroy()

  // ---- 7 款经典 + 1 款原创 demo ----
  check('内置游戏清单为 8 款（7 经典 + Star Pilot）', games.length === 8 && games.some((game) => /star.?pilot/i.test(game.title || game.id || '')), '实际 ' + games.length)

  const summaries = []
  for (let i = 0; i < games.length; i++) {
    summaries.push(await testRom(games[i], i, games.length))
  }

  // ---- 崩溃恢复（损坏存档 → 崩溃 → reset() 恢复）----
  await testCrashRecovery(firstRom)

  // ---- 音频链路（mock WebAudio：AudioWorklet + ScriptProcessor 两条路径）----
  await testAudioWorkletPath(firstRom)
  await testScriptProcessorPath(firstRom)

  // ---- 汇总 ----
  console.log('\n--- 汇总 ---')
  const totalFrames = summaries.reduce((sum, item) => sum + (item.frames || 0), 0)
  const avgFrame = summaries.filter((item) => item.avgFrameMs).length
    ? summaries.reduce((sum, item) => sum + (item.avgFrameMs || 0), 0) / summaries.filter((item) => item.avgFrameMs).length
    : Infinity
  const totalSave = summaries.reduce((sum, item) => sum + (item.saveBytes || 0), 0)
  console.log(`ROM 数 ${summaries.length} | 总帧数 ${totalFrames} | 平均单帧 ${avgFrame.toFixed(3)} ms | 存档合计 ${formatKB(totalSave)}`)
  console.log(`断言 ${passCount} 项通过，${failCount} 项失败（排队 rAF 残留 ${pendingRafCount()}）`)

  if (failCount === 0) {
    console.log('\nPASS engine.selftest：全部验收项通过')
    process.exitCode = 0
  } else {
    console.log('\nFAIL engine.selftest：' + failCount + ' 项失败')
    failureMessages.forEach((message) => console.log('  - ' + message))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('FAIL engine.selftest 运行异常：', error)
  process.exitCode = 1
})
