window.__ModuleLoader__.load({
  id: '@local/game-bench',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ================================================================== *
     * 拾光游戏厅（Game Bench）— DSH Web 客户端
     *
     * 视图：游戏库（library）/ 游戏市场（market）/ 播放器（player）/ 设置（settings）
     * 运行时：Host 提供 /game-bench/api/*，模拟器由 window.GameBenchCore 提供。
     * 本文件单文件、无构建、仅依赖 react；所有可见文案走 locale 注册 + t()。
     * ================================================================== */

    const NS = 'game-bench'
    const API = '/game-bench/api'
    const FRAME_W = 256
    const FRAME_H = 240
    const SAVE_SLOTS = ['auto', '1', '2', '3']
    const DB_NAME = 'game-bench'
    const DB_VERSION = 1
    const STORE_SAVES = 'saves'
    const STORE_PROGRESS = 'progress'
    const STORE_SETTINGS = 'settings'
    const AUTOSAVE_MS = 60000

    /* ------------------------------------------------------------------ *
     * 文案：中文兜底；英文走 ctx.locale 注册（字典在文件末尾）
     * ------------------------------------------------------------------ */
    let translate = (key, params) => interpolate(ZH[key] || key, params)
    const localeListeners = new Set()
    let localeVersion = 0

    function interpolate(text, params) {
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function useT() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const listener = () => setTick((value) => value + 1)
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      }, [])
      return translate
    }

    function bumpLocale() {
      localeVersion += 1
      localeListeners.forEach((listener) => {
        try {
          listener()
        } catch {
          /* ignore */
        }
      })
    }

    /* ------------------------------------------------------------------ *
     * 通用工具
     * ------------------------------------------------------------------ */
    const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))
    const cx = (...parts) => parts.filter(Boolean).join(' ')
    const text = (value) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

    function makeError(message, code) {
      const error = new Error(message || '')
      error.code = code || 'INTERNAL'
      return error
    }

    function errorInfo(error) {
      return {
        code: (error && error.code) || 'INTERNAL',
        message: text(error && error.message) || translate('error.unknown'),
      }
    }

    function qs(params) {
      const search = new URLSearchParams()
      Object.keys(params || {}).forEach((key) => {
        const value = params[key]
        if (value === undefined || value === null || value === '') return
        search.set(key, String(value))
      })
      return search.toString()
    }

    function apiUrl(path, params) {
      const query = params ? qs(params) : ''
      return API + path + (query ? '?' + query : '')
    }

    async function requestJson(path, params, options) {
      let response = null
      try {
        response = await fetch(apiUrl(path, params), Object.assign({
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        }, options || {}))
      } catch {
        throw makeError(translate('error.network'), 'NETWORK')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!payload || payload.ok !== true) {
        const statusAuth = response.status === 401 || response.status === 403
        const message = text(payload && payload.error) || (statusAuth ? translate('market.auth.short') : translate('error.network'))
        throw makeError(message, (payload && payload.code) || (statusAuth ? 'AUTH' : 'NETWORK'))
      }
      return payload.data
    }

    function apiGet(path, params) {
      return requestJson(path, params)
    }

    function apiPost(path, body) {
      return requestJson(path, null, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    function bytesText(size) {
      const value = Number(size) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function relTime(timestamp) {
      const value = Number(timestamp) || 0
      if (!value) return translate('time.never')
      const diff = Date.now() - value
      if (diff < 45000) return translate('time.justNow')
      const minutes = Math.floor(diff / 60000)
      if (minutes < 60) return translate('time.minutesAgo', { n: Math.max(1, minutes) })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return translate('time.hoursAgo', { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return translate('time.daysAgo', { n: days })
      const date = new Date(value)
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function timeText(timestamp) {
      if (!timestamp) return ''
      const date = new Date(timestamp)
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function durationText(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds) || 0))
      if (total < 60) return translate('duration.seconds', { n: total })
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return translate('duration.minutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      return translate('duration.hours', { n: hours, m: pad2(minutes % 60) })
    }

    /* 稳定色块：同一标题永远同一颜色，封面缺失时也不难看 */
    const FALLBACK_COLORS = [
      ['#2563eb', '#7d0a1b'],
      ['#1f6fb2', '#123c62'],
      ['#c98a12', '#7c5406'],
      ['#2f8f5b', '#16553a'],
      ['#7a4bb5', '#422663'],
      ['#d8592a', '#7d2c10'],
    ]

    function hashText(value) {
      const source = text(value) || 'game-bench'
      let hash = 2166136261
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    function fallbackColor(title) {
      return FALLBACK_COLORS[hashText(title) % FALLBACK_COLORS.length]
    }

    function initialOf(title) {
      const source = text(title).trim()
      if (!source) return '?'
      return Array.from(source)[0]
    }

    function coverUrl(game) {
      if (!game) return ''
      if (text(game.cover)) return text(game.cover)
      return API + '/cover/' + encodeURIComponent(text(game.id))
    }

    function languageLabel(language) {
      const value = text(language).toLowerCase()
      if (!value) return ''
      if (value === 'zh-label' || value === 'zh' || value === 'zh-cn' || value === 'zh-hans') return translate('language.zh')
      if (value === 'zh-trad' || value === 'zh-hant' || value === 'zh-tw') return translate('language.trad')
      return ''
    }

    function errMessage(error) {
      return text(error && error.message)
    }

    /* ------------------------------------------------------------------ *
     * IndexedDB：saves / progress / settings；打不开时降级到内存 Map
     * ------------------------------------------------------------------ */
    const memoryStores = {
      [STORE_SAVES]: new Map(),
      [STORE_PROGRESS]: new Map(),
      [STORE_SETTINGS]: new Map(),
    }
    let dbPromise = null

    function openDb() {
      if (dbPromise) return dbPromise
      dbPromise = new Promise((resolve) => {
        let request = null
        try {
          if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null)
          request = indexedDB.open(DB_NAME, DB_VERSION)
        } catch {
          return resolve(null)
        }
        request.onupgradeneeded = () => {
          try {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE_SAVES)) db.createObjectStore(STORE_SAVES)
            if (!db.objectStoreNames.contains(STORE_PROGRESS)) db.createObjectStore(STORE_PROGRESS)
            if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS)
          } catch {
            /* ignore */
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      })
      return dbPromise
    }

    function memGet(store, key) {
      return memoryStores[store] ? memoryStores[store].get(key) : undefined
    }

    async function dbGet(store, key) {
      const db = await openDb()
      if (!db) return memGet(store, key)
      return new Promise((resolve) => {
        try {
          const request = db.transaction(store, 'readonly').objectStore(store).get(key)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      })
    }

    async function dbGetAll(store) {
      const db = await openDb()
      if (!db) return Array.from((memoryStores[store] || new Map()).values())
      return new Promise((resolve) => {
        try {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll()
          request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
          request.onerror = () => resolve([])
        } catch {
          resolve([])
        }
      })
    }

    async function dbPut(store, key, value) {
      const db = await openDb()
      if (!db) {
        if (memoryStores[store]) memoryStores[store].set(key, value)
        return
      }
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, 'readwrite')
          tx.objectStore(store).put(value, key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
          tx.onabort = () => resolve()
        } catch {
          if (memoryStores[store]) memoryStores[store].set(key, value)
          resolve()
        }
      })
    }

    async function dbDelete(store, key) {
      const db = await openDb()
      if (!db) {
        if (memoryStores[store]) memoryStores[store].delete(key)
        return
      }
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, 'readwrite')
          tx.objectStore(store).delete(key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
          tx.onabort = () => resolve()
        } catch {
          resolve()
        }
      })
    }

    function saveKey(gameId, slot) {
      return text(gameId) + '#' + text(slot)
    }

    async function readSaves(gameId) {
      const all = await dbGetAll(STORE_SAVES)
      const id = text(gameId)
      return all
        .filter((record) => record && record.gameId === id)
        .sort((a, b) => SAVE_SLOTS.indexOf(a.slot) - SAVE_SLOTS.indexOf(b.slot))
    }

    async function readSave(gameId, slot) {
      return dbGet(STORE_SAVES, saveKey(gameId, slot))
    }

    async function writeSave(record) {
      if (!record || !record.gameId) return
      await dbPut(STORE_SAVES, saveKey(record.gameId, record.slot), record)
    }

    async function readProgressMap() {
      const all = await dbGetAll(STORE_PROGRESS)
      const map = {}
      all.forEach((record) => {
        if (record && record.gameId) map[record.gameId] = record
      })
      return map
    }

    async function writeProgress(record) {
      if (!record || !record.gameId) return
      await dbPut(STORE_PROGRESS, record.gameId, record)
    }

    const SCREEN_MODES = ['fit', 'stretch', 'pixel']

    const DEFAULT_UI = {
      volume: 0.8,
      muted: false,
      speed: 1,
      crt: false,
      showFps: false,
      keys: 'default',
      screenMode: 'fit',
    }

    function normalizeUi(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        volume: clamp(num(source.volume, DEFAULT_UI.volume), 0, 1),
        muted: !!source.muted,
        speed: [0.5, 1, 2].indexOf(num(source.speed, 1)) >= 0 ? num(source.speed, 1) : 1,
        crt: source.crt === undefined ? DEFAULT_UI.crt : !!source.crt,
        showFps: !!source.showFps,
        keys: source.keys === 'arcade' ? 'arcade' : 'default',
        screenMode: SCREEN_MODES.indexOf(source.screenMode) >= 0 ? source.screenMode : DEFAULT_UI.screenMode,
      }
    }

    /* ------------------------------------------------------------------ *
     * 全局状态 store（组件通过 useSyncExternalStore 订阅）
     * ------------------------------------------------------------------ */
    const initialState = {
      ready: false,
      view: 'library',
      status: null,
      statusError: null,
      library: null,
      libraryLoading: true,
      libraryError: null,
      market: null,
      marketLoading: false,
      marketError: null,
      catalog: null,
      catalogLoading: false,
      catalogError: null,
      query: '',
      collection: '',
      progress: {},
      ui: DEFAULT_UI,
      settings: null,
      settingsError: null,
      current: null,
      playerPhase: 'idle',
      playerError: null,
      audioReady: false,
      engineState: {
        running: false,
        paused: false,
        crashed: false,
        audio: 'off',
        fps: 0,
        frames: 0,
        romTitle: '',
      },
      saves: [],
      savePanel: null,
      keyHintsOpen: true,
      touchMode: false,
      installing: {},
      installError: {},
      uninstallConfirm: '',
      uninstallBusy: '',
      toast: null,
      syncBusy: false,
      mediaConflict: false,
      gamepadConnected: false,
      fullscreen: false,
    }

    let state = initialState
    const storeListeners = new Set()
    const getSnapshot = () => state

    function subscribeStore(listener) {
      storeListeners.add(listener)
      return () => {
        storeListeners.delete(listener)
      }
    }

    function emitStore() {
      storeListeners.forEach((listener) => {
        try {
          listener()
        } catch {
          /* ignore */
        }
      })
    }

    function setState(patch) {
      if (!patch) return
      const next = typeof patch === 'function' ? patch(state) : patch
      if (!next) return
      state = Object.assign({}, state, next)
      emitStore()
    }

    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)
      }
      const [snapshot, setSnapshot] = React.useState(getSnapshot)
      React.useEffect(() => subscribeStore(() => setSnapshot(getSnapshot())), [])
      return snapshot
    }

    let toastTimer = null
    function toast(message, kind, silent) {
      if (!message) return
      setState({ toast: { text: message, kind: kind || 'info', id: Date.now() } })
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => setState({ toast: null }), kind === 'error' ? 6200 : 3400)
      if (silent) return
      return message
    }

    /* ------------------------------------------------------------------ *
     * 数据加载：状态 / 游戏库 / 市场 / 目录 / 安装
     * ------------------------------------------------------------------ */
    function omit(map, key) {
      const next = Object.assign({}, map)
      delete next[key]
      return next
    }

    function libraryGames() {
      return state.library && Array.isArray(state.library.games) ? state.library.games : []
    }

    function findGame(gameId) {
      const id = text(gameId)
      return libraryGames().find((game) => game && game.id === id) || null
    }

    function isInstalled(gameId) {
      return !!findGame(gameId)
    }

    async function loadStatus() {
      try {
        const status = await apiGet('/status')
        setState({ status: status || null, statusError: null })
      } catch (error) {
        setState({ statusError: errorInfo(error) })
      }
    }

    async function loadLibrary() {
      setState({ libraryLoading: true, libraryError: null })
      try {
        const data = await apiGet('/library')
        const games = data && Array.isArray(data.games) ? data.games : []
        setState({
          library: {
            games,
            builtinCount: num(data && data.builtinCount, 0),
            installedCount: num(data && data.installedCount, 0),
          },
          libraryLoading: false,
          libraryError: null,
        })
        return games
      } catch (error) {
        setState({ libraryLoading: false, libraryError: errorInfo(error) })
        return []
      }
    }

    async function loadMarket() {
      setState({ marketLoading: true, marketError: null })
      try {
        const data = await apiGet('/market')
        setState({ market: data || null, marketLoading: false, marketError: null })
        if (!state.catalog) runCatalog({ q: '', collection: '', offset: 0 })
        return data
      } catch (error) {
        setState({ marketLoading: false, marketError: errorInfo(error) })
        return null
      }
    }

    let catalogToken = 0

    async function runCatalog(options) {
      const opts = options || {}
      const q = text(opts.q)
      const collection = text(opts.collection)
      const offset = Math.max(0, num(opts.offset, 0))
      const append = !!opts.append
      const token = ++catalogToken
      setState({ catalogLoading: true, catalogError: null })
      try {
        const data = await apiGet('/catalog', { q, collection, offset, limit: 60 })
        if (token !== catalogToken) return
        const items = data && Array.isArray(data.items) ? data.items : []
        const previous = append && state.catalog ? state.catalog.items : []
        setState({
          catalogLoading: false,
          catalogError: null,
          catalog: {
            items: append ? previous.concat(items) : items,
            total: num(data && data.total, items.length),
            offset: num(data && data.offset, offset),
            limit: num(data && data.limit, 60),
            q,
            collection,
          },
        })
      } catch (error) {
        if (token !== catalogToken) return
        setState({ catalogLoading: false, catalogError: errorInfo(error) })
      }
    }

    async function installGame(game) {
      if (!game || !game.id) return null
      if (state.installing[game.id]) return null
      setState({
        installing: Object.assign({}, state.installing, { [game.id]: true }),
        installError: Object.assign({}, state.installError, { [game.id]: '' }),
      })
      try {
        const data = await apiPost('/install', { id: game.id })
        const installed = data && data.game ? data.game : game
        setState({ installing: omit(state.installing, game.id) })
        await loadLibrary()
        toast(translate('market.installSuccess', { title: text(installed.title || game.title) }), 'success')
        return installed
      } catch (error) {
        const info = errorInfo(error)
        setState({
          installing: omit(state.installing, game.id),
          installError: Object.assign({}, state.installError, { [game.id]: info.message }),
        })
        toast(translate('toast.error', { error: info.message }), 'error')
        return null
      }
    }

    async function uninstallGame(gameId) {
      const id = text(gameId)
      if (!id || state.uninstallBusy) return
      const game = findGame(id)
      setState({ uninstallBusy: id })
      try {
        await apiPost('/uninstall', { id })
        setState({ uninstallBusy: '', uninstallConfirm: '' })
        await loadLibrary()
        toast(translate('market.uninstallSuccess', { title: text(game && game.title) }), 'success')
      } catch (error) {
        const info = errorInfo(error)
        setState({ uninstallBusy: '' })
        toast(translate('toast.error', { error: info.message }), 'error')
      }
    }

    async function loadSettings() {
      try {
        const data = await apiGet('/settings')
        setState({ settings: data || null, settingsError: null })
      } catch (error) {
        setState({ settingsError: errorInfo(error) })
      }
    }

    async function saveSettings(patch) {
      setState({ settingsSaving: true })
      try {
        await apiPost('/settings', patch || {})
        await loadSettings()
        await loadStatus()
        setState({ settingsSaving: false })
        toast(translate('settings.saved'), 'success')
        return true
      } catch (error) {
        const info = errorInfo(error)
        setState({ settingsSaving: false })
        toast(translate('settings.failed', { error: info.message }), 'error')
        return false
      }
    }

    async function syncMarket() {
      if (state.syncBusy) return
      setState({ syncBusy: true })
      try {
        const data = await apiPost('/sync', {})
        setState({ syncBusy: false })
        await loadStatus()
        await loadMarket()
        await runCatalog({ q: state.query, collection: state.collection, offset: 0 })
        toast(translate('market.synced', { n: num(data && data.total, 0) }), 'success')
      } catch (error) {
        const info = errorInfo(error)
        setState({ syncBusy: false })
        toast(translate('market.syncFailed', { error: info.message }), 'error')
      }
    }

    function goto(view) {
      const next = ['library', 'market', 'settings'].indexOf(view) >= 0 ? view : 'library'
      if (next === 'market' && !state.market && !state.marketLoading) loadMarket()
      if (next === 'settings') {
        loadSettings()
        loadStatus()
      }
      setState({ view: next })
    }

    function progressList() {
      return Object.keys(state.progress || {})
        .map((key) => state.progress[key])
        .filter((record) => record && record.gameId)
        .sort((a, b) => num(b.lastPlayedAt, 0) - num(a.lastPlayedAt, 0))
    }

    function continueRecord() {
      const list = progressList()
      for (let index = 0; index < list.length; index += 1) {
        const record = list[index]
        const game = findGame(record.gameId)
        if (game) return { game, record }
      }
      return null
    }

    /* ------------------------------------------------------------------ *
     * 玩家运行时：加载 runtime、创建 engine、生命周期与输入
     * ------------------------------------------------------------------ */
    let engine = null
    let engineCanvas = null
    let engineGameId = ''
    let engineStarted = false
    let engineGen = 0
    let lastEngineSig = ''
    let playerGame = null
    let autosaveTimer = null
    let uiSaveTimer = null
    let mediaTimer = null
    let mediaToastAt = 0
    let playStartedAt = 0
    let audioGestureAt = 0

    function emptyEngineState() {
      return { running: false, paused: false, crashed: false, audio: 'off', fps: 0, frames: 0, romTitle: '' }
    }

    /* 画面 CSS 尺寸（canvas 内部分辨率始终 256x240）：
     *  fit     4:3 电视比例，占满可用高度，横向按 CRT 观感拉伸 1.25x
     *  stretch 铺满可用区域（允许变形）
     *  pixel   整数倍像素放大，保持像素清晰
     */
    function screenSizeFor(mode, availW, availH) {
      const width = Math.max(1, Math.round(Number(availW) || 0))
      const height = Math.max(1, Math.round(Number(availH) || 0))
      if (mode === 'stretch') return { w: width, h: height }
      if (mode === 'pixel') {
        const scale = Math.max(1, Math.floor(Math.min(width / FRAME_W, height / FRAME_H)))
        return { w: FRAME_W * scale, h: FRAME_H * scale }
      }
      const h = Math.min(height, Math.round((width * 3) / 4))
      const w = Math.round((h * 4) / 3)
      return { w: Math.max(1, w), h: Math.max(1, h) }
    }

    function setScreenMode(mode) {
      const next = SCREEN_MODES.indexOf(mode) >= 0 ? mode : 'fit'
      patchUi({ screenMode: next })
    }

    function cycleScreenMode() {
      const index = SCREEN_MODES.indexOf(state.ui.screenMode)
      const next = SCREEN_MODES[(index + 1) % SCREEN_MODES.length]
      patchUi({ screenMode: next })
      toast(translate('player.screenModeChanged', { mode: translate('player.screen.' + next) }), 'info')
    }

    function isTypingTarget(element) {
      if (!element) return false
      const tag = text(element.tagName).toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      return element.isContentEditable === true
    }

    function panelFocused() {
      let root = null
      try {
        root = document.querySelector('[data-gb="root"]')
      } catch {
        root = null
      }
      /* 面板根找不到（非常规挂载）时仍允许按键：此时监听只在播放器存活期间存在 */
      if (!root) return true
      const active = document.activeElement
      if (!active || active === document.body || active === document.documentElement) return true
      return root.contains(active)
    }

    function currentEngine() {
      return engine
    }

    /* runtime script 加载：jsnes 先、engine 后，缓存 Promise，失败可重试 */
    const scriptCache = new Map()

    function loadScript(src) {
      if (scriptCache.has(src)) return scriptCache.get(src)
      const promise = new Promise((resolve, reject) => {
        let element = null
        try {
          element = document.createElement('script')
          element.src = src
          element.async = false
          element.setAttribute('data-gb-runtime', '')
        } catch {
          reject(makeError(translate('error.runtimeMissing'), 'UNSUPPORTED'))
          return
        }
        const timer = setTimeout(() => {
          reject(makeError(translate('error.runtimeMissing'), 'UNSUPPORTED'))
        }, 25000)
        element.onload = () => {
          clearTimeout(timer)
          resolve()
        }
        element.onerror = () => {
          clearTimeout(timer)
          try {
            element.remove()
          } catch {
            /* ignore */
          }
          reject(makeError(translate('error.runtimeMissing'), 'NETWORK'))
        }
        try {
          document.head.appendChild(element)
        } catch {
          clearTimeout(timer)
          reject(makeError(translate('error.runtimeMissing'), 'UNSUPPORTED'))
        }
      })
      scriptCache.set(src, promise)
      promise.catch(() => {
        scriptCache.delete(src)
      })
      return promise
    }

    let corePromise = null

    async function loadCore() {
      if (window.GameBenchCore && typeof window.GameBenchCore.create === 'function') return window.GameBenchCore
      if (corePromise) return corePromise
      corePromise = (async () => {
        await loadScript(API + '/vendor/jsnes.js')
        await loadScript(API + '/engine.js')
        if (!window.GameBenchCore || typeof window.GameBenchCore.create !== 'function') {
          throw makeError(translate('error.runtimeMissing'), 'UNSUPPORTED')
        }
        return window.GameBenchCore
      })()
      corePromise.catch(() => {
        corePromise = null
      })
      return corePromise
    }

    async function fetchRom(gameId) {
      const id = text(gameId)
      let response = null
      try {
        response = await fetch(API + '/rom/' + encodeURIComponent(id), { cache: 'no-store' })
      } catch {
        throw makeError(translate('error.network'), 'NETWORK')
      }
      if (!response.ok) {
        let message = translate('error.romMissing')
        let code = 'NOT_FOUND'
        const type = text(response.headers.get('content-type'))
        if (type.indexOf('json') >= 0) {
          try {
            const payload = await response.json()
            if (payload && payload.error) {
              message = text(payload.error)
              code = text(payload.code) || code
            }
          } catch {
            /* ignore */
          }
        }
        throw makeError(message, code)
      }
      try {
        const buffer = await response.arrayBuffer()
        if (!buffer || !buffer.byteLength) throw makeError(translate('error.badRom'), 'NOT_FOUND')
        return new Uint8Array(buffer)
      } catch (error) {
        if (error && error.code) throw error
        throw makeError(translate('error.network'), 'NETWORK')
      }
    }

    function engineSignature(next) {
      return [
        next.running ? 1 : 0,
        next.paused ? 1 : 0,
        next.crashed ? 1 : 0,
        text(next.audio),
        state.ui.showFps ? Math.round(num(next.fps, 0)) : 0,
        text(next.romTitle),
      ].join('|')
    }

    function onEngineState(next) {
      if (!next) return
      const signature = engineSignature(next)
      if (signature === lastEngineSig) return
      lastEngineSig = signature
      setState({
        engineState: {
          running: !!next.running,
          paused: !!next.paused,
          crashed: !!next.crashed,
          audio: text(next.audio) || 'off',
          fps: num(next.fps, 0),
          frames: num(next.frames, 0),
          romTitle: text(next.romTitle),
        },
      })
    }

    function onEngineError(error) {
      const info = errorInfo(error)
      setState({ runtimeError: info })
      toast(translate('toast.error', { error: info.message }), 'error')
    }

    async function bootPlayer(canvas, game) {
      if (!canvas || !game || !game.id) return
      if (engine && engineGameId === game.id && engineCanvas === canvas) return
      teardownPlayer()
      const generation = (engineGen += 1)
      lastEngineSig = ''
      setState({
        playerPhase: 'boot',
        playerError: null,
        audioReady: false,
        engineState: emptyEngineState(),
        mediaConflict: false,
        runtimeError: null,
      })
      try {
        const core = await loadCore()
        if (generation !== engineGen) return
        const rom = await fetchRom(game.id)
        if (generation !== engineGen) return
        const created = core.create({
          canvas,
          volume: state.ui.muted ? 0 : state.ui.volume,
          muted: state.ui.muted,
          speed: state.ui.speed,
          onState: onEngineState,
          onError: onEngineError,
        })
        if (generation !== engineGen) {
          try {
            created.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        engine = created
        engineCanvas = canvas
        engineGameId = game.id
        engineStarted = false
        playerGame = game
        created.loadRom(rom)
        created.setSpeed(state.ui.speed)
        created.setMuted(!!state.ui.muted)
        created.setVolume(state.ui.muted ? 0 : state.ui.volume)
        bindPlayerInput()
        refreshSaves(game.id)
        setState({ playerPhase: 'ready', playerError: null })
        /* 等用户点击「点击开始」遮罩再 engine.start()，避开自动播放策略 */
      } catch (error) {
        if (generation !== engineGen) return
        const info = errorInfo(error)
        teardownPlayer()
        setState({ playerPhase: 'error', playerError: info, runtimeError: info })
      }
    }

    function teardownPlayer() {
      engineGen += 1
      stopAutosave()
      unbindPlayerInput()
      stopGamepadPolling()
      const dying = engine
      const dyingGame = playerGame
      const wasStarted = engineStarted
      finishProgress()
      engine = null
      engineCanvas = null
      engineGameId = ''
      engineStarted = false
      playerGame = null
      lastEngineSig = ''
      pressedCodes.clear()
      padDown.clear()
      if (!dying) return
      try {
        dying.releaseAll()
      } catch {
        /* ignore */
      }
      try {
        dying.pause()
      } catch {
        /* ignore */
      }
      let destroyed = false
      const destroy = () => {
        if (destroyed) return
        destroyed = true
        try {
          dying.destroy()
        } catch {
          /* ignore */
        }
      }
      const timer = setTimeout(destroy, 6000)
      if (!wasStarted) {
        clearTimeout(timer)
        destroy()
        return
      }
      Promise.resolve()
        .then(() => dying.saveState())
        .then((bytes) => {
          if (bytes && dyingGame) return persistSave(dyingGame, 'auto', bytes, true)
          return null
        })
        .catch(() => {
          /* 存档失败不阻塞退出 */
        })
        .finally(() => {
          clearTimeout(timer)
          destroy()
        })
    }

    function startAudio() {
      if (engineStarted) {
        setState({ audioReady: true })
        return
      }
      const eng = engine
      if (!eng) return
      engineStarted = true
      setState({ audioReady: true })
      try {
        eng.start()
      } catch {
        /* ignore */
      }
      startAutosave()
      beginProgress(playerGame)
      audioGestureAt = Date.now()
    }

    function beginProgress(game) {
      if (!game || !game.id) return
      const existing = state.progress[game.id] || {}
      const record = {
        gameId: game.id,
        title: text(game.title),
        lastPlayedAt: Date.now(),
        playSeconds: num(existing.playSeconds, 0),
      }
      playStartedAt = Date.now()
      setState({ progress: Object.assign({}, state.progress, { [game.id]: record }) })
      writeProgress(record)
    }

    function finishProgress() {
      const game = playerGame
      if (!game || !playStartedAt) {
        playStartedAt = 0
        return
      }
      const existing = state.progress[game.id] || {}
      const elapsed = Math.max(0, Math.round((Date.now() - playStartedAt) / 1000))
      const record = {
        gameId: game.id,
        title: text(game.title),
        lastPlayedAt: Date.now(),
        playSeconds: num(existing.playSeconds, 0) + elapsed,
      }
      playStartedAt = 0
      setState({ progress: Object.assign({}, state.progress, { [game.id]: record }) })
      writeProgress(record)
    }

    function slotText(slot) {
      if (slot === 'auto') return translate('player.save.auto')
      return translate('player.save.slot', { n: slot })
    }

    async function persistSave(game, slot, bytes, quiet) {
      if (!game || !game.id || !bytes) return null
      const record = {
        gameId: game.id,
        slot,
        title: text(game.title),
        state: bytes,
        updatedAt: Date.now(),
        label: slotText(slot),
        size: bytes.length || 0,
        playSeconds: num((state.progress[game.id] || {}).playSeconds, 0),
      }
      const eng = engine
      if (eng && typeof eng.snapshot === 'function') {
        try {
          const thumb = eng.snapshot()
          if (thumb && thumb.length < 140000) record.thumb = thumb
        } catch {
          /* 缩略图可选 */
        }
      }
      await writeSave(record)
      if (state.current && state.current.id === game.id) await refreshSaves(game.id)
      if (!quiet) toast(translate('player.save.saved', { slot: slotText(slot) }), 'success')
      return record
    }

    async function saveToSlot(slot) {
      const game = state.current
      if (!game || !engine) return
      try {
        const bytes = await engine.saveState()
        await persistSave(game, slot, bytes)
        setState({ savePanel: null })
      } catch (error) {
        toast(translate('player.save.failed', { error: errMessage(error) }), 'error')
      }
    }

    async function loadFromSlot(slot) {
      const game = state.current
      if (!game || !engine) return
      try {
        const record = await readSave(game.id, slot)
        if (!record || !record.state) {
          toast(translate('player.save.emptySlot'), 'info')
          return
        }
        await engine.loadState(record.state)
        if (engineStarted) engine.resume()
        setState({ savePanel: null, engineState: Object.assign({}, state.engineState, { paused: false }) })
        toast(translate('player.save.loaded', { slot: slotText(slot) }), 'success')
      } catch (error) {
        toast(translate('player.save.loadFailed', { error: errMessage(error) }), 'error')
      }
    }

    async function refreshSaves(gameId) {
      const records = await readSaves(gameId)
      setState({ saves: records })
    }

    async function autosaveNow(quiet) {
      const game = state.current || playerGame
      if (!game || !game.id || !engine || !engineStarted) return
      try {
        const bytes = await engine.saveState()
        await persistSave(game, 'auto', bytes, true)
        if (!quiet) toast(translate('player.save.autoSaved'), 'info')
      } catch {
        /* 自动存档静默失败，不打断游玩 */
      }
    }

    function startAutosave() {
      stopAutosave()
      autosaveTimer = setInterval(() => {
        if (!engine || !engineStarted) return
        if (state.engineState.paused) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        autosaveNow(true)
      }, AUTOSAVE_MS)
    }

    function stopAutosave() {
      if (autosaveTimer) {
        clearInterval(autosaveTimer)
        autosaveTimer = null
      }
    }

    function togglePause() {
      const eng = engine
      if (!eng) return
      if (!engineStarted) {
        startAudio()
        return
      }
      const paused = !state.engineState.paused
      try {
        eng.togglePause()
      } catch {
        return
      }
      setState({ engineState: Object.assign({}, state.engineState, { paused }) })
      if (paused) autosaveNow(true)
    }

    function resumeGame() {
      const eng = engine
      if (!eng) return
      try {
        eng.resume()
      } catch {
        /* ignore */
      }
      setState({ engineState: Object.assign({}, state.engineState, { paused: false }) })
    }

    function resetGame() {
      const eng = engine
      if (!eng) return
      try {
        eng.reset()
        eng.releaseAll()
      } catch {
        /* ignore */
      }
      setState({ engineState: Object.assign({}, state.engineState, { crashed: false }) })
      toast(translate('player.resetDone'), 'info')
    }

    function setVolume(value) {
      const volume = clamp(value, 0, 1)
      patchUi({ volume, muted: volume === 0 ? state.ui.muted : false })
      const eng = engine
      if (eng) {
        try {
          eng.setVolume(volume)
          eng.setMuted(state.ui.muted)
        } catch {
          /* ignore */
        }
      }
    }

    function toggleMute() {
      const muted = !state.ui.muted
      patchUi({ muted })
      const eng = engine
      if (eng) {
        try {
          eng.setMuted(muted)
          eng.setVolume(state.ui.volume)
        } catch {
          /* ignore */
        }
      }
    }

    function setSpeed(speed) {
      const value = [0.5, 1, 2].indexOf(num(speed, 1)) >= 0 ? num(speed, 1) : 1
      patchUi({ speed: value })
      const eng = engine
      if (eng) {
        try {
          eng.setSpeed(value)
        } catch {
          /* ignore */
        }
      }
    }

    function toggleCrt() {
      patchUi({ crt: !state.ui.crt })
    }

    function toggleShowFps() {
      patchUi({ showFps: !state.ui.showFps })
    }

    function setKeyScheme(scheme) {
      patchUi({ keys: scheme === 'arcade' ? 'arcade' : 'default' })
    }

    function patchUi(patch) {
      const ui = normalizeUi(Object.assign({}, state.ui, patch || {}))
      setState({ ui })
      if (uiSaveTimer) clearTimeout(uiSaveTimer)
      uiSaveTimer = setTimeout(() => {
        uiSaveTimer = null
        dbPut(STORE_SETTINGS, 'ui', ui)
      }, 250)
    }

    function toggleSavePanel(mode) {
      setState({ savePanel: state.savePanel === mode ? null : mode })
    }

    function toggleKeyHints() {
      setState({ keyHintsOpen: !state.keyHintsOpen })
    }

    function playGame(game) {
      if (!game || !game.id) return
      pauseOtherMedia(null)
      setState({
        current: game,
        view: 'player',
        playerPhase: 'boot',
        playerError: null,
        audioReady: false,
        savePanel: null,
        mediaConflict: false,
        runtimeError: null,
        saves: [],
        engineState: emptyEngineState(),
      })
    }

    function exitPlayer() {
      teardownPlayer()
      setState({
        view: 'library',
        current: null,
        playerPhase: 'idle',
        savePanel: null,
        audioReady: false,
        mediaConflict: false,
        engineState: emptyEngineState(),
      })
    }

    function openUninstallConfirm(gameId) {
      setState({ uninstallConfirm: state.uninstallConfirm === gameId ? '' : gameId })
    }

    /* ------------------------------------------------------------------ *
     * 媒体仲裁：进游戏时暂停页面上其它 <audio>/<video>；别人开播则暂停游戏
     * （只操作媒体元素本身，不读取其它插件的 DOM 结构）
     * ------------------------------------------------------------------ */
    function mediaElements() {
      try {
        return Array.prototype.slice.call(document.querySelectorAll('audio,video'))
      } catch {
        return []
      }
    }

    function otherMediaPlaying() {
      return mediaElements().some((element) => !element.paused && !element.ended)
    }

    function pauseOtherMedia(except) {
      mediaElements().forEach((element) => {
        if (!element || element === except) return
        if (!element.paused) {
          try {
            element.pause()
          } catch {
            /* ignore */
          }
        }
      })
    }

    function onOtherMediaPlay(event) {
      const element = event && event.target
      if (!element) return
      const tag = text(element.tagName).toUpperCase()
      if (tag !== 'AUDIO' && tag !== 'VIDEO') return
      const eng = engine
      if (!eng || state.engineState.paused || !engineStarted) return
      try {
        eng.pause()
      } catch {
        return
      }
      setState({ engineState: Object.assign({}, state.engineState, { paused: true }), mediaConflict: true })
      if (!mediaToastAt || Date.now() - mediaToastAt > 8000) {
        mediaToastAt = Date.now()
        toast(translate('player.mediaPaused'), 'info')
      }
    }

    function setupMediaArbitration() {
      document.addEventListener('play', onOtherMediaPlay, true)
      mediaTimer = setInterval(() => {
        const eng = engine
        if (!eng || !engineStarted || state.engineState.paused) return
        if (otherMediaPlaying()) onOtherMediaPlay({ target: mediaElements().find((element) => !element.paused) })
      }, 2500)
      return () => {
        document.removeEventListener('play', onOtherMediaPlay, true)
        if (mediaTimer) {
          clearInterval(mediaTimer)
          mediaTimer = null
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * 键盘 / 手柄输入
     * ------------------------------------------------------------------ */
    const KEYMAP_DEFAULT = {
      ArrowUp: 'UP',
      ArrowDown: 'DOWN',
      ArrowLeft: 'LEFT',
      ArrowRight: 'RIGHT',
      KeyZ: 'B',
      KeyX: 'A',
      Enter: 'START',
      NumpadEnter: 'START',
      ShiftLeft: 'SELECT',
      ShiftRight: 'SELECT',
    }

    const KEYMAP_ARCADE = Object.assign({}, KEYMAP_DEFAULT, {
      KeyZ: 'A',
      KeyX: 'B',
    })

    const PAD_BUTTONS = { 0: 'A', 1: 'B', 8: 'SELECT', 9: 'START', 12: 'UP', 13: 'DOWN', 14: 'LEFT', 15: 'RIGHT' }
    const pressedCodes = new Set()
    let padDown = new Set()
    let padTimer = null
    let keyboardBound = false

    function activeKeymap() {
      return state.ui.keys === 'arcade' ? KEYMAP_ARCADE : KEYMAP_DEFAULT
    }

    function onKeyDown(event) {
      if (!engine) return
      if (!event || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (!panelFocused()) return
      const code = text(event.code)
      if (code === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (state.savePanel) {
          setState({ savePanel: null })
          return
        }
        try {
          if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen()
            return
          }
        } catch {
          /* ignore */
        }
        exitPlayer()
        return
      }
      if (!engineStarted) return
      const map = activeKeymap()
      const name = map[code]
      if (!name) return
      event.preventDefault()
      event.stopPropagation()
      pressedCodes.add(code)
      try {
        engine.setButton(name, true)
      } catch {
        /* ignore */
      }
    }

    function onKeyUp(event) {
      const code = text(event && event.code)
      if (!code) return
      if (!pressedCodes.has(code)) return
      pressedCodes.delete(code)
      const map = activeKeymap()
      const name = map[code]
      if (!name) return
      event.preventDefault()
      if (engine) {
        try {
          engine.setButton(name, false)
        } catch {
          /* ignore */
        }
      }
    }

    function releaseKeyboard() {
      const eng = engine
      const map = activeKeymap()
      pressedCodes.forEach((code) => {
        const name = map[code]
        if (name && eng) {
          try {
            eng.setButton(name, false)
          } catch {
            /* ignore */
          }
        }
      })
      pressedCodes.clear()
    }

    function onWindowBlur() {
      releaseKeyboard()
      releasePad()
      if (engine) {
        try {
          engine.releaseAll()
        } catch {
          /* ignore */
        }
      }
    }

    function bindPlayerInput() {
      if (keyboardBound) return
      keyboardBound = true
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('keyup', onKeyUp, true)
      window.addEventListener('blur', onWindowBlur)
      startGamepadPolling()
    }

    function unbindPlayerInput() {
      if (!keyboardBound) return
      keyboardBound = false
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onWindowBlur)
      releaseKeyboard()
    }

    function releasePad() {
      const eng = engine
      padDown.forEach((name) => {
        if (eng) {
          try {
            eng.setButton(name, false)
          } catch {
            /* ignore */
          }
        }
      })
      padDown = new Set()
    }

    function gamepadList() {
      try {
        if (typeof navigator === 'undefined' || !navigator.getGamepads) return []
        const pads = navigator.getGamepads()
        if (!pads) return []
        return Array.prototype.slice.call(pads)
      } catch {
        return []
      }
    }

    function startGamepadPolling() {
      if (padTimer) return
      padTimer = setInterval(() => {
        const eng = engine
        if (!eng || !engineStarted) return
        const pads = gamepadList()
        let pad = null
        for (let index = 0; index < pads.length; index += 1) {
          if (pads[index] && pads[index].connected) {
            pad = pads[index]
            break
          }
        }
        const connected = !!pad
        if (connected !== state.gamepadConnected) setState({ gamepadConnected: connected })
        if (!pad) {
          releasePad()
          return
        }
        const next = new Set()
        const buttons = pad.buttons || []
        Object.keys(PAD_BUTTONS).forEach((index) => {
          const button = buttons[index]
          if (button && (button.pressed || num(button.value, 0) > 0.5)) next.add(PAD_BUTTONS[index])
        })
        const axes = pad.axes || []
        if (num(axes[0], 0) < -0.45) next.add('LEFT')
        if (num(axes[0], 0) > 0.45) next.add('RIGHT')
        if (num(axes[1], 0) < -0.45) next.add('UP')
        if (num(axes[1], 0) > 0.45) next.add('DOWN')
        next.forEach((name) => {
          if (!padDown.has(name)) {
            padDown.add(name)
            try {
              eng.setButton(name, true)
            } catch {
              /* ignore */
            }
          }
        })
        padDown.forEach((name) => {
          if (!next.has(name)) {
            padDown.delete(name)
            try {
              eng.setButton(name, false)
            } catch {
              /* ignore */
            }
          }
        })
      }, 16)
    }

    function stopGamepadPolling() {
      if (padTimer) {
        clearInterval(padTimer)
        padTimer = null
      }
      releasePad()
    }

    /* 虚拟按键（触屏）：按下/松开，带 pointer capture，不依赖键盘 */
    function setVirtualButton(name, down) {
      const eng = engine
      if (!eng) return
      try {
        eng.setButton(name, !!down)
      } catch {
        /* ignore */
      }
    }

    /* ------------------------------------------------------------------ *
     * 页面隐藏：暂停 + 自动存档（持久监听，apply 时注册）
     * ------------------------------------------------------------------ */
    function onVisibilityChange() {
      if (!document.hidden) return
      const eng = engine
      if (!eng) return
      try {
        eng.pause()
        eng.releaseAll()
      } catch {
        /* ignore */
      }
      releaseKeyboard()
      releasePad()
      setState({ engineState: Object.assign({}, state.engineState, { paused: true }) })
      autosaveNow(true)
    }

    function screenshot() {
      const eng = engine
      const game = state.current
      if (!eng || !game) return
      let dataUrl = ''
      try {
        dataUrl = eng.snapshot()
      } catch {
        dataUrl = ''
      }
      if (!dataUrl) {
        toast(translate('player.screenshotFailed'), 'error')
        return
      }
      try {
        const anchor = document.createElement('a')
        anchor.href = dataUrl
        const safeTitle = text(game.title).replace(/[\\/:*?"<>|\s]+/g, '_') || 'game-bench'
        anchor.download = safeTitle + '-' + Date.now() + '.png'
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        setTimeout(() => {
          try {
            anchor.remove()
          } catch {
            /* ignore */
          }
        }, 0)
        toast(translate('player.screenshotSaved'), 'success')
      } catch {
        toast(translate('player.screenshotFailed'), 'error')
      }
    }

    function toggleFullscreen() {
      const shell = document.querySelector('[data-gb-player]')
      if (!shell) return
      try {
        if (document.fullscreenElement) {
          document.exitFullscreen()
        } else if (shell.requestFullscreen) {
          shell.requestFullscreen()
        }
      } catch {
        /* ignore */
      }
    }

    function onFullscreenChange() {
      setState({ fullscreen: !!document.fullscreenElement })
    }

    /* ------------------------------------------------------------------ *
     * 启动：读取本地 UI 偏好 / 进度，拉取状态与游戏库
     * ------------------------------------------------------------------ */
    async function bootstrap() {
      try {
        const rawUi = await dbGet(STORE_SETTINGS, 'ui')
        if (rawUi) {
          const normalized = normalizeUi(rawUi)
          /* 旧版本默认开着很重的 CRT；升级后第一次读档先回到「关闭」，用户想要可再手动打开 */
          if (rawUi.screenMode === undefined) normalized.crt = false
          setState({ ui: normalized })
        }
      } catch {
        /* ignore */
      }
      try {
        const progress = await readProgressMap()
        setState({ progress })
      } catch {
        /* ignore */
      }
      await Promise.all([loadStatus(), loadLibrary()])
      setState({ ready: true })
      if (typeof window !== 'undefined' && window.matchMedia) {
        try {
          const coarse = window.matchMedia('(pointer: coarse)').matches
          const narrow = window.matchMedia('(max-width: 860px)').matches
          setState({ touchMode: !!(coarse || narrow) })
        } catch {
          /* ignore */
        }
      }
    }

    /* ================================================================== *
     * 图标（全部内联 SVG，尺寸随 prop，不用 emoji）
     * ================================================================== */
    const ICONS = {
      play: [['path', { d: 'M8.5 5.6v12.8L19 12z', fill: 'currentColor', stroke: 'none' }]],
      pause: [
        ['rect', { x: 7, y: 5.5, width: 3.4, height: 13, rx: 1.1, fill: 'currentColor', stroke: 'none' }],
        ['rect', { x: 13.6, y: 5.5, width: 3.4, height: 13, rx: 1.1, fill: 'currentColor', stroke: 'none' }],
      ],
      back: [['path', { d: 'M14.5 5.5 8 12l6.5 6.5' }], ['path', { d: 'M8.4 12H20' }]],
      gear: [
        ['path', { d: 'M19.3 13.2v-2.4l-2-.5a5.9 5.9 0 0 0-.6-1.5l1.1-1.8-1.7-1.7-1.8 1.1a5.9 5.9 0 0 0-1.5-.6L12.3 4H9.9l-.5 2a5.9 5.9 0 0 0-1.5.6L6.1 5.5 4.4 7.2l1.1 1.8a5.9 5.9 0 0 0-.6 1.5l-2 .5v2.4l2 .5c.1.5.3 1 .6 1.5l-1.1 1.8 1.7 1.7 1.8-1.1c.5.3 1 .5 1.5.6l.5 2h2.4l.5-2c.5-.1 1-.3 1.5-.6l1.8 1.1 1.7-1.7-1.1-1.8c.3-.5.5-1 .6-1.5Z' }],
        ['circle', { cx: 11.1, cy: 12, r: 2.9 }],
      ],
      search: [['circle', { cx: 10.8, cy: 10.8, r: 6.2 }], ['path', { d: 'm15.4 15.4 4.1 4.1' }]],
      download: [['path', { d: 'M12 4.5v10' }], ['path', { d: 'm7.8 10.4 4.2 4.2 4.2-4.2' }], ['path', { d: 'M5 19.5h14' }]],
      check: [['path', { d: 'm5.5 12.5 4.2 4.2 8.8-9.4' }]],
      more: [
        ['circle', { cx: 6, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }],
        ['circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }],
        ['circle', { cx: 18, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }],
      ],
      close: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
      trash: [
        ['path', { d: 'M4.8 6.8h14.4' }],
        ['path', { d: 'M9.5 6.8V4.9h5v1.9' }],
        ['path', { d: 'M6.6 6.8 7.5 20h9l.9-13.2' }],
        ['path', { d: 'M10.2 10.4v6M13.8 10.4v6' }],
      ],
      reset: [['path', { d: 'M19.4 12a7.4 7.4 0 1 1-2.2-5.2' }], ['path', { d: 'M19.6 4.4v4.8h-4.8' }]],
      save: [
        ['path', { d: 'M5.6 4.8h9.2l4.6 4.6v9.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19.2V6.4a1.6 1.6 0 0 1 1.6-1.6Z' }],
        ['path', { d: 'M8.2 4.8v5h7v-5' }],
        ['rect', { x: 8.2, y: 13, width: 7.6, height: 6 }],
      ],
      load: [['path', { d: 'M4.6 8.4 6.4 4.8h11.2l1.8 3.6' }], ['path', { d: 'M4.6 8.4h14.8v9.6a1.6 1.6 0 0 1-1.6 1.6H6.2a1.6 1.6 0 0 1-1.6-1.6Z' }], ['path', { d: 'M12 11.4v5.2M9.4 14.2 12 16.8l2.6-2.6' }]],
      volume: [
        ['path', { d: 'M4.6 9.6h3.2L12 6v12l-4.2-3.6H4.6Z' }],
        ['path', { d: 'M15.4 9.2a4.2 4.2 0 0 1 0 5.6' }],
        ['path', { d: 'M17.9 6.8a7.6 7.6 0 0 1 0 10.4' }],
      ],
      mute: [['path', { d: 'M4.6 9.6h3.2L12 6v12l-4.2-3.6H4.6Z' }], ['path', { d: 'm15.6 9.6 4.4 4.8M20 9.6l-4.4 4.8' }]],
      speed: [['path', { d: 'M4.4 17.6a8.2 8.2 0 1 1 15.2 0' }], ['path', { d: 'M12 14.6l3.6-4.4' }], ['circle', { cx: 12, cy: 15.4, r: 1.3, fill: 'currentColor', stroke: 'none' }]],
      crt: [['rect', { x: 3.4, y: 5.4, width: 17.2, height: 11.6, rx: 2.2 }], ['path', { d: 'M8.4 20.4h7.2' }], ['path', { d: 'M10.6 17v3.4M13.4 17v3.4' }]],
      ratio: [['rect', { x: 3.4, y: 6, width: 17.2, height: 12, rx: 2 }], ['path', { d: 'M8.4 6v12M15.6 6v12' }]],
      camera: [['path', { d: 'M3.8 8.6h3.1l1.5-2.2h7.2l1.5 2.2h3.1v9.6a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8Z' }], ['circle', { cx: 12, cy: 13.2, r: 3.2 }]],
      fullscreen: [['path', { d: 'M4.4 9.2V4.4h4.8M15 4.4h4.6v4.8M19.6 14.8v4.8H15M9.2 19.6H4.4v-4.8' }]],
      minimize: [['path', { d: 'M9.2 4.4v4.8H4.4M19.6 9.2h-4.8V4.4M14.8 19.6v-4.8h4.8M4.4 14.8h4.8v4.8' }]],
      loader: [['path', { d: 'M20 12a8 8 0 1 1-4.6-7.2' }]],
      grid: [
        ['rect', { x: 4, y: 4, width: 6.8, height: 6.8, rx: 1.8 }],
        ['rect', { x: 13.2, y: 4, width: 6.8, height: 6.8, rx: 1.8 }],
        ['rect', { x: 4, y: 13.2, width: 6.8, height: 6.8, rx: 1.8 }],
        ['rect', { x: 13.2, y: 13.2, width: 6.8, height: 6.8, rx: 1.8 }],
      ],
      bag: [['path', { d: 'M4.6 8.2h14.8l-1.2 11.2a1.7 1.7 0 0 1-1.7 1.5H7.5a1.7 1.7 0 0 1-1.7-1.5Z' }], ['path', { d: 'M8.6 10.4V7.2a3.4 3.4 0 0 1 6.8 0v3.2' }]],
      star: [['path', { d: 'm12 4.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8Z' }]],
      refresh: [['path', { d: 'M20 12a8 8 0 0 1-13.7 5.6' }], ['path', { d: 'M4 12a8 8 0 0 1 13.7-5.6' }], ['path', { d: 'M17.7 3.4v3.4h-3.4M6.3 20.6v-3.4h3.4' }]],
      wifiOff: [['path', { d: 'M3.6 3.6l16.8 16.8' }], ['path', { d: 'M8.4 15.2a5.2 5.2 0 0 1 3.6-1.6c.8 0 1.5.2 2.2.5' }], ['path', { d: 'M5.2 11.8a9.4 9.4 0 0 1 3-1.9M12 6.2a9.6 9.6 0 0 1 6.8 2.6' }], ['circle', { cx: 12, cy: 18.4, r: 1.2, fill: 'currentColor', stroke: 'none' }]],
      lock: [['rect', { x: 5.4, y: 10.4, width: 13.2, height: 9.4, rx: 2 }], ['path', { d: 'M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4' }]],
      info: [['circle', { cx: 12, cy: 12, r: 8.2 }], ['path', { d: 'M12 11v5.4' }], ['circle', { cx: 12, cy: 8, r: 0.9, fill: 'currentColor', stroke: 'none' }]],
      keys: [['rect', { x: 2.8, y: 6.2, width: 18.4, height: 11.6, rx: 2.2 }], ['path', { d: 'M6.6 10h.1M9.8 10h.1M13 10h.1M16.2 10h.1M6.6 13.4h8M16.2 13.4h.1' }]],
      dot: [['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor', stroke: 'none' }]],
    }

    function Icon(props) {
      const name = (props && props.name) || 'dot'
      const size = (props && props.size) || 18
      const strokeWidth = (props && props.strokeWidth) || 1.8
      const items = ICONS[name] || ICONS.dot
      return h(
        'svg',
        {
          className: cx('gb-ico', props && props.className),
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        items.map((item, index) => h(item[0], Object.assign({ key: index }, item[1]))),
      )
    }

    /* 像素手柄：header logo 与侧栏入口共用的手绘图 */
    function PixelPad(props) {
      const size = (props && props.size) || 32
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 32 32',
          shapeRendering: 'crispEdges',
          'aria-hidden': 'true',
          focusable: 'false',
          className: cx('gb-pad-art', props && props.className),
        },
        h('rect', { x: 0, y: 0, width: 32, height: 32, rx: 8, fill: 'transparent' }),
        h('rect', { x: 1.5, y: 9, width: 29, height: 16, rx: 3.4, fill: '#2563eb' }),
        h('rect', { x: 2.5, y: 10, width: 27, height: 5, rx: 2.4, fill: '#60a5fa' }),
        h('rect', { x: 2.5, y: 22, width: 27, height: 2, rx: 1, fill: '#172554' }),
        /* 十字键 */
        h('rect', { x: 5.5, y: 15, width: 9, height: 3.6, fill: '#fff8ec' }),
        h('rect', { x: 8.2, y: 12.3, width: 3.6, height: 9, fill: '#fff8ec' }),
        h('rect', { x: 5.5, y: 17.4, width: 9, height: 1.2, fill: '#efe0c6' }),
        h('rect', { x: 10.6, y: 12.3, width: 1.2, height: 9, fill: '#efe0c6' }),
        /* A / B */
        h('circle', { cx: 22.4, cy: 19.4, r: 2.1, fill: '#f5b731' }),
        h('circle', { cx: 25.9, cy: 15.9, r: 2.1, fill: '#f5b731' }),
        h('rect', { x: 21.4, y: 18, width: 1.4, height: 1.4, fill: '#fff8ec' }),
        h('rect', { x: 24.9, y: 14.5, width: 1.4, height: 1.4, fill: '#fff8ec' }),
        /* SELECT / START */
        h('rect', { x: 16.1, y: 22.2, width: 2.2, height: 1.7, fill: '#fff8ec', opacity: 0.86 }),
        h('rect', { x: 19.1, y: 22.2, width: 2.2, height: 1.7, fill: '#fff8ec', opacity: 0.86 }),
      )
    }
    /* 线稿摇杆：几何来自 Lucide「joystick」(ISC License, https://lucide.dev)，
    * 小尺寸用更粗描边保证 20px 可辨；颜色由调用方决定。 */
    function JoystickGlyph(props) {
      const size = (props && props.size) || 20
      const color = (props && props.color) || 'currentColor'
      const stroke = (props && props.stroke) || 2.1
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: color,
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M21 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2Z' }),
        h('path', { d: 'M6 15v-2' }),
        h('path', { d: 'M12 15V9' }),
        h('circle', { cx: 12, cy: 6, r: 3 }),
      )
    }

    /* 侧栏/品牌图标：斜向七彩条纹牌 + 白色线稿摇杆。
    * 七种颜色按固定 4 单位宽度循环铺满，避免角落色块与中心色带宽度不一致；摇杆来自 Lucide「joystick」
    * (ISC License, https://lucide.dev)，小尺寸加粗描边保证 20px 可辨。 */
    let gbIdSeed = 0
    function JoyBadge(props) {
      const size = (props && props.size) || 20
      const stroke = (props && props.stroke) || (size <= 20 ? 2.4 : size <= 30 ? 2.1 : 1.9)
      const glyph = (props && props.glyph) || '#ffffff'
      const id = React.useMemo
        ? React.useMemo(() => 'jbg' + (++gbIdSeed), [])
        : 'jbg' + (++gbIdSeed)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 40 40',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h(
          'defs',
          null,
          h(
            'pattern',
            { id, patternUnits: 'userSpaceOnUse', width: 28, height: 28, patternTransform: 'rotate(45)' },
            ['#df5366', '#e89542', '#e6c653', '#52a978', '#479fc1', '#557dcc', '#9577b8'].map((color, i) =>
              h('rect', { key: color, x: i * 4, y: 0, width: 4, height: 28, fill: color }),
            ),
          ),
        ),
        h('rect', { x: 0, y: 0, width: 40, height: 40, rx: 11.5, fill: 'url(#' + id + ')' }),
        h('rect', {
          x: 0.6,
          y: 0.6,
          width: 38.8,
          height: 38.8,
          rx: 11,
          fill: 'none',
          stroke: 'rgba(255,255,255,.28)',
          strokeWidth: 1.2,
        }),
        h(
          'g',
          {
            transform: 'translate(6.8 6.8) scale(1.1)',
            fill: 'none',
            stroke: glyph,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('path', { d: 'M21 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2Z' }),
          h('path', { d: 'M6 15v-2' }),
          h('path', { d: 'M12 15V9' }),
          h('circle', { cx: 12, cy: 6, r: 3 }),
        ),
      )
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 20
      const active = !!(props && props.active)
      return h(
        'span',
        {
          className: cx('gb-panel-mark', active && 'is-active'),
          'data-gb-entry': '',
          style: {
            width: size + 'px',
            height: size + 'px',
            display: 'block',
            lineHeight: 0,
            borderRadius: Math.round(size * 0.28) + 'px',
            filter: active ? 'brightness(1.08)' : 'none',
            transform: 'none',
            transition: 'filter 160ms ease, transform 160ms ease',
          },
        },
        h(JoyBadge, { size: size }),
      )
    }

    /* ================================================================== *
     * 通用小部件
     * ================================================================== */
    function Cover(props) {
      const game = props.game
      const [broken, setBroken] = React.useState(false)
      const src = coverUrl(game)
      React.useEffect(() => {
        setBroken(false)
      }, [src])
      const colors = fallbackColor(game && game.title)
      const fallbackStyle = {
        background: 'linear-gradient(155deg,' + colors[0] + ',' + colors[1] + ')',
      }
      return h(
        'div',
        { className: cx('gb-cover', broken && 'is-fallback'), style: broken ? fallbackStyle : null },
        !broken && src
          ? h('img', {
              className: 'gb-cover-img',
              src,
              alt: '',
              draggable: false,
              loading: 'lazy',
              onError: () => setBroken(true),
            })
          : h(
              'span',
              { className: 'gb-cover-initial', 'aria-hidden': 'true' },
              h('span', { className: 'gb-cover-initial-glyph' }, initialOf(game && game.title)),
              h('span', { className: 'gb-cover-initial-pixel' }),
            ),
        h('span', { className: 'gb-cover-scan', 'aria-hidden': 'true' }),
      )
    }

    function Badge(props) {
      return h(
        'span',
        { className: cx('gb-badge', props && props.tone && 'is-' + props.tone) },
        props && props.icon ? h(Icon, { name: props.icon, size: 11, strokeWidth: 2 }) : null,
        props && props.children ? props.children : null,
      )
    }

    function Toast(props) {
      const item = props.toast
      if (!item) return null
      const icon = item.kind === 'error' ? 'info' : item.kind === 'success' ? 'check' : 'info'
      return h(
        'div',
        { className: cx('gb-toast', item.kind && 'is-' + item.kind), role: 'status', 'data-gb-toast': item.kind || 'info' },
        h(Icon, { name: icon, size: 15, strokeWidth: 2.2 }),
        h('span', null, item.text),
      )
    }

    function Spinner(props) {
      return h(Icon, { name: 'loader', size: (props && props.size) || 14, className: 'is-spinning', strokeWidth: 2.2 })
    }

    function StateCard(props) {
      const tone = props.tone || 'info'
      return h(
        'div',
        { className: cx('gb-state', 'is-' + tone) },
        h('span', { className: 'gb-state-icon' }, h(Icon, { name: props.icon || 'info', size: 25 })),
        h('h3', { className: 'gb-state-title' }, props.title),
        props.desc ? h('p', { className: 'gb-state-desc' }, props.desc) : null,
        props.hint ? h('p', { className: 'gb-state-hint' }, props.hint) : null,
        props.actions ? h('div', { className: 'gb-state-actions' }, props.actions) : null,
      )
    }

    function SkeletonGrid(props) {
      const count = (props && props.count) || 8
      const items = []
      for (let index = 0; index < count; index += 1) items.push(index)
      return h(
        'div',
        { className: cx('gb-grid', props && props.compact && 'is-compact'), 'data-gb-status': 'skeleton', 'aria-hidden': 'true' },
        items.map((index) =>
          h(
            'div',
            { className: 'gb-skeleton', key: index },
            h('span', { className: 'gb-skeleton-cover' }),
            h('span', { className: 'gb-skeleton-line' }),
            h('span', { className: 'gb-skeleton-line short' }),
          ),
        ),
      )
    }

    /* ================================================================== *
     * Header / Tabs
     * ================================================================== */
    function Header(props) {
      const t = useT()
      const s = props.state
      const countsKnown = !!(s.status || s.library)
      const builtin = s.status ? num(s.status.builtinCount, 0) : s.library ? num(s.library.builtinCount, 0) : 0
      const installed = s.status ? num(s.status.installedCount, 0) : s.library ? num(s.library.installedCount, 0) : 0
      return h(
        'header',
        { className: 'gb-head' },
        h(
          'div',
          { className: 'gb-brand' },
          h('span', { className: 'gb-brand-mark', 'aria-hidden': 'true' }, h(JoyBadge, { size: 40, stroke: 1.9 })),
          h(
            'div',
            { className: 'gb-brand-text' },
            h('h1', { className: 'gb-brand-title' }, t('meta.title')),
            h('p', { className: 'gb-brand-sub' }, t('meta.subtitle')),
          ),
        ),
        h(
          'div',
          { className: 'gb-head-right' },
          countsKnown
            ? h(
                'span',
                { className: 'gb-chip gb-chip-quiet', 'data-gb-badge': 'builtin' },
                h(Icon, { name: 'star', size: 12 }),
                t('meta.badgeBuiltin', { n: builtin }),
              )
            : null,
          countsKnown
            ? h(
                'span',
                { className: 'gb-chip gb-chip-quiet', 'data-gb-badge': 'installed' },
                h(Icon, { name: 'download', size: 12 }),
                t('meta.badgeInstalled', { n: installed }),
              )
            : null,
          s.view === 'settings'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'gb-icon-btn',
                  'data-gb-settings-back': '',
                  title: t('action.back'),
                  'aria-label': t('action.back'),
                  onClick: () => goto('library'),
                },
                h(Icon, { name: 'back', size: 17 }),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: cx('gb-icon-btn', s.view === 'settings' && 'is-on'),
                  'data-gb-settings': '',
                  title: t('settings.title'),
                  'aria-label': t('settings.title'),
                  onClick: () => goto('settings'),
                },
                h(Icon, { name: 'gear', size: 17 }),
              ),
        ),
      )
    }

    function Tabs(props) {
      const t = useT()
      const s = props.state
      if (s.view === 'player') return null
      const libraryActive = s.view === 'library'
      const marketActive = s.view === 'market'
      const total = s.market ? num(s.market.total, 0) : s.status && s.status.market ? num(s.status.market.catalogGames, 0) : 0
      return h(
        'nav',
        { className: 'gb-tabs', role: 'tablist', 'aria-label': t('meta.title') },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': libraryActive,
            className: cx('gb-tab', libraryActive && 'is-active'),
            'data-gb-tab': 'library',
            onClick: () => goto('library'),
          },
          h(Icon, { name: 'grid', size: 15 }),
          h('span', null, t('tab.library')),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': marketActive,
            className: cx('gb-tab', marketActive && 'is-active'),
            'data-gb-tab': 'market',
            onClick: () => goto('market'),
          },
          h(Icon, { name: 'bag', size: 15 }),
          h('span', null, t('tab.market')),
          total ? h('span', { className: 'gb-tab-count' }, total > 999 ? '999+' : total) : null,
        ),
      )
    }

    /* ================================================================== *
     * 游戏库
     * ================================================================== */
    function ContinueHero(props) {
      const t = useT()
      const game = props.game
      const record = props.record
      return h(
        'section',
        { className: 'gb-hero', 'data-gb-continue': game.id },
        h('div', { className: 'gb-hero-bg', 'aria-hidden': 'true' }, h(Cover, { game })),
        h(
          'div',
          { className: 'gb-hero-body' },
          h(
            'span',
            { className: 'gb-hero-eyebrow' },
            h(Icon, { name: 'keys', size: 13 }),
            t('library.hero.eyebrow'),
          ),
          h('h2', { className: 'gb-hero-title' }, game.title),
          h(
            'p',
            { className: 'gb-hero-meta' },
            t('library.hero.lastPlayed', { time: relTime(record.lastPlayedAt) }),
            record.playSeconds ? h('span', { className: 'gb-dot' }, '·') : null,
            record.playSeconds ? t('library.hero.playedFor', { time: durationText(record.playSeconds) }) : null,
          ),
          h(
            'div',
            { className: 'gb-hero-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'gb-btn gb-btn-accent gb-btn-lg',
                'data-gb-continue-btn': game.id,
                onClick: () => playGame(game),
              },
              h(Icon, { name: 'play', size: 15 }),
              t('library.hero.continue'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'gb-btn gb-btn-lg',
                onClick: () => playGame(game),
              },
              h(Icon, { name: 'reset', size: 15 }),
              t('library.hero.restart'),
            ),
          ),
        ),
        h('div', { className: 'gb-hero-art', 'aria-hidden': 'true' }, h(PixelPad, { size: 108 })),
      )
    }

    function WelcomeHero() {
      const t = useT()
      return h(
        'section',
        { className: 'gb-hero is-welcome', 'data-gb-welcome': '' },
        h(
          'div',
          { className: 'gb-hero-body' },
          h(
            'span',
            { className: 'gb-hero-eyebrow' },
            h(Icon, { name: 'keys', size: 13 }),
            t('library.welcome.eyebrow'),
          ),
          h('h2', { className: 'gb-hero-title' }, t('library.welcome.title')),
          h('p', { className: 'gb-hero-meta' }, t('library.welcome.desc')),
          h(
            'div',
            { className: 'gb-hero-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'gb-btn gb-btn-accent gb-btn-lg',
                onClick: () => {
                  const first = libraryGames()[0]
                  if (first) playGame(first)
                },
              },
              h(Icon, { name: 'play', size: 15 }),
              t('library.welcome.playFirst'),
            ),
            h(
              'button',
              { type: 'button', className: 'gb-btn gb-btn-lg', onClick: () => goto('market') },
              h(Icon, { name: 'bag', size: 15 }),
              t('library.welcome.browseMarket'),
            ),
          ),
        ),
        h('div', { className: 'gb-hero-art', 'aria-hidden': 'true' }, h(PixelPad, { size: 108 })),
      )
    }

    function GameCard(props) {
      const t = useT()
      const game = props.game
      const record = props.progress
      const [menuOpen, setMenuOpen] = React.useState(false)
      const canUninstall = !game.builtin
      const confirming = props.confirmId === game.id
      const busy = props.uninstallBusy === game.id
      const lang = languageLabel(game.language)
      return h(
        'article',
        { className: cx('gb-card', menuOpen && 'is-menu-open'), 'data-gb-card': game.id },
        h(
          'button',
          {
            type: 'button',
            className: 'gb-card-hit',
            'aria-label': t('action.playGame', { title: text(game.title) }),
            onClick: () => playGame(game),
          },
          h(
            'span',
            { className: 'gb-card-cover' },
            h(Cover, { game }),
            h(
              'span',
              { className: 'gb-card-badges' },
              game.builtin
                ? h(Badge, { tone: 'red' }, t('library.builtin'))
                : h(Badge, { tone: 'gold' }, t('library.downloaded')),
              lang ? h(Badge, { tone: 'quiet' }, lang) : null,
            ),
            h(
              'span',
              { className: 'gb-card-play' },
              h(Icon, { name: 'play', size: 16 }),
              t('action.play'),
            ),
          ),
          h(
            'span',
            { className: 'gb-card-info' },
            h('span', { className: 'gb-card-title', title: text(game.title) }, text(game.title)),
            h(
              'span',
              { className: 'gb-card-sub' },
              record && record.lastPlayedAt
                ? t('library.lastPlayed', { time: relTime(record.lastPlayedAt) })
                : t('library.neverPlayed'),
            ),
          ),
        ),
        canUninstall
          ? h(
              'div',
              { className: 'gb-card-menu' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'gb-icon-btn gb-card-menu-btn',
                  'data-gb-menu': game.id,
                  'aria-label': t('action.more'),
                  'aria-expanded': menuOpen,
                  onClick: (event) => {
                    event.stopPropagation()
                    setMenuOpen(!menuOpen)
                    if (confirming) setState({ uninstallConfirm: '' })
                  },
                },
                h(Icon, { name: 'more', size: 16 }),
              ),
              menuOpen
                ? h(
                    'div',
                    { className: 'gb-menu', role: 'menu' },
                    confirming
                      ? h(
                          'div',
                          { className: 'gb-menu-confirm', 'data-gb-uninstall-confirm': game.id },
                          h('p', null, t('library.deleteAsk', { title: text(game.title) })),
                          h(
                            'div',
                            { className: 'gb-menu-confirm-actions' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'gb-btn gb-btn-sm',
                                onClick: () => {
                                  setState({ uninstallConfirm: '' })
                                  setMenuOpen(false)
                                },
                              },
                              t('action.cancel'),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'gb-btn gb-btn-sm is-danger',
                                'data-gb-uninstall': game.id,
                                disabled: busy,
                                onClick: () => {
                                  uninstallGame(game.id)
                                  setMenuOpen(false)
                                },
                              },
                              busy ? h(Spinner, { size: 12 }) : null,
                              busy ? t('action.deleting') : t('action.delete'),
                            ),
                          ),
                          h('p', { className: 'gb-menu-note' }, t('library.deleteNote')),
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'gb-menu-item is-danger',
                            role: 'menuitem',
                            onClick: () => setState({ uninstallConfirm: game.id }),
                          },
                          h(Icon, { name: 'trash', size: 14 }),
                          t('action.delete'),
                        ),
                  )
                : null,
            )
          : null,
      )
    }

    function LibraryView(props) {
      const t = useT()
      const s = props.state
      const games = libraryGames()
      const cont = continueRecord()
      let status = 'library-ready'
      if (s.libraryLoading && !s.library) status = 'library-loading'
      else if (s.libraryError) status = 'library-error'
      else if (!games.length) status = 'library-empty'

      if (status === 'library-loading') {
        return h('div', { className: 'gb-view', 'data-gb-status': status }, h(SkeletonGrid, { count: 8 }))
      }
      if (status === 'library-error') {
        return h(
          'div',
          { className: 'gb-view', 'data-gb-status': status },
          h(StateCard, {
            tone: 'error',
            icon: 'wifiOff',
            status,
            title: t('library.error.title'),
            desc: s.libraryError.message,
            hint: t('library.error.hint'),
            actions: h(
              'button',
              { type: 'button', className: 'gb-btn gb-btn-accent', onClick: () => loadLibrary() },
              h(Icon, { name: 'refresh', size: 14 }),
              t('action.retry'),
            ),
          }),
        )
      }
      if (status === 'library-empty') {
        return h(
          'div',
          { className: 'gb-view', 'data-gb-status': status },
          h(StateCard, {
            tone: 'info',
            icon: 'grid',
            status,
            title: t('library.empty.title'),
            desc: t('library.empty.desc'),
            actions: h(
              'button',
              { type: 'button', className: 'gb-btn gb-btn-accent', onClick: () => goto('market') },
              h(Icon, { name: 'bag', size: 14 }),
              t('library.empty.action'),
            ),
          }),
        )
      }
      return h(
        'div',
        { className: 'gb-view', 'data-gb-status': status },
        cont ? h(ContinueHero, { game: cont.game, record: cont.record }) : h(WelcomeHero),
        h(
          'div',
          { className: 'gb-section-head' },
          h('h2', { className: 'gb-section-title' }, t('library.section.all')),
          h('span', { className: 'gb-section-count' }, t('library.section.count', { n: games.length })),
        ),
        h(
          'div',
          { className: 'gb-grid' },
          games.map((game) =>
            h(GameCard, {
              key: game.id,
              game,
              progress: s.progress[game.id],
              confirmId: s.uninstallConfirm,
              uninstallBusy: s.uninstallBusy,
            }),
          ),
        ),
        h(
          'p',
          { className: 'gb-foot' },
          h(Icon, { name: 'info', size: 12 }),
          t('library.footnote'),
        ),
      )
    }

    /* ================================================================== *
     * 游戏市场
     * ================================================================== */
    function MarketCard(props) {
      const t = useT()
      const game = props.game
      if (!game || !game.id) return null
      const installed = isInstalled(game.id)
      const busy = !!state.installing[game.id]
      const failure = text(state.installError[game.id])
      const lang = languageLabel(game.language)
      return h(
        'article',
        { className: cx('gb-market-card', busy && 'is-busy'), 'data-gb-market': game.id },
        h(
          'div',
          { className: 'gb-market-cover' },
          h(Cover, { game }),
          h(
            'div',
            { className: 'gb-market-badges' },
            installed ? h(Badge, { tone: 'red' }, t('market.installed')) : null,
            lang ? h(Badge, { tone: 'quiet' }, lang) : null,
          ),
        ),
        h(
          'div',
          { className: 'gb-market-info' },
          h('span', { className: 'gb-market-title', title: text(game.title) }, text(game.title)),
          h(
            'span',
            { className: 'gb-market-meta' },
            game.size ? bytesText(game.size) : game.series ? text(game.series) : t('market.nes'),
          ),
          failure ? h('p', { className: 'gb-inline-error', 'data-gb-install-error': game.id }, failure) : null,
          busy
            ? h(
                'span',
                { className: 'gb-progress', 'aria-hidden': 'true' },
                h('span', { className: 'gb-progress-bar' }),
              )
            : null,
          installed
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'gb-btn gb-btn-accent gb-btn-sm gb-btn-block',
                  'data-gb-install': game.id,
                  'data-gb-installed': '1',
                  onClick: () => playGame(findGame(game.id) || game),
                },
                h(Icon, { name: 'play', size: 13 }),
                t('market.playInstalled'),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: cx('gb-btn gb-btn-sm gb-btn-block', busy && 'is-busy'),
                  'data-gb-install': game.id,
                  disabled: busy,
                  onClick: () => installGame(game),
                },
                busy ? h(Spinner, { size: 13 }) : h(Icon, { name: 'download', size: 13 }),
                busy ? t('action.installing') : t('action.install'),
              ),
        ),
      )
    }

    function MarketRail(props) {
      const games = Array.isArray(props.games) ? props.games : []
      if (!games.length) return null
      return h(
        'section',
        { className: 'gb-rail' },
        h(
          'div',
          { className: 'gb-rail-head' },
          h('h3', { className: 'gb-rail-title' }, props.title),
          props.subtitle ? h('span', { className: 'gb-rail-sub' }, props.subtitle) : null,
        ),
        h('div', { className: 'gb-rail-scroll' }, games.map((game) => h(MarketCard, { key: game.id, game }))),
      )
    }

    function MarketSkeleton() {
      const rails = [0, 1]
      return h(
        'div',
        { className: 'gb-market-home', 'aria-hidden': 'true' },
        rails.map((index) =>
          h(
            'div',
            { className: 'gb-rail', key: index },
            h('div', { className: 'gb-rail-head' }, h('span', { className: 'gb-skeleton-line title' })),
            h(
              'div',
              { className: 'gb-rail-scroll' },
              [0, 1, 2, 3, 4].map((card) =>
                h(
                  'div',
                  { className: 'gb-skeleton gb-skeleton-card', key: card },
                  h('span', { className: 'gb-skeleton-cover' }),
                  h('span', { className: 'gb-skeleton-line' }),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function MarketEmpty(props) {
      const t = useT()
      return h(StateCard, {
        tone: 'info',
        icon: 'search',
        status: 'market-empty',
        title: props.collection ? t('market.empty.collectionTitle') : t('market.empty.title', { q: props.query }),
        desc: props.collection ? t('market.empty.collectionDesc') : t('market.empty.desc'),
        actions: h(
          'button',
          {
            type: 'button',
            className: 'gb-btn gb-btn-accent',
            onClick: () => {
              setState({ query: '', collection: '' })
              runCatalog({ q: '', collection: '', offset: 0 })
            },
          },
          h(Icon, { name: 'refresh', size: 14 }),
          t('market.empty.reset'),
        ),
      })
    }

    function MarketAuthState() {
      const t = useT()
      return h(
        'div',
        { className: 'gb-view' },
        h(
          'div',
          { className: 'gb-state is-auth' },
          h('span', { className: 'gb-state-icon' }, h(Icon, { name: 'lock', size: 25 })),
          h('h3', { className: 'gb-state-title' }, t('market.auth.title')),
          h('p', { className: 'gb-state-desc' }, t('market.auth.desc')),
          h(
            'pre',
            { className: 'gb-code' },
            h('code', null, 'gh auth login'),
          ),
          h('p', { className: 'gb-state-hint' }, t('market.auth.hint')),
          h(
            'div',
            { className: 'gb-state-actions' },
            h(
              'button',
              { type: 'button', className: 'gb-btn gb-btn-accent', onClick: () => goto('settings') },
              h(Icon, { name: 'gear', size: 14 }),
              t('market.auth.goSettings'),
            ),
            h(
              'button',
              { type: 'button', className: 'gb-btn', onClick: () => loadMarket() },
              h(Icon, { name: 'refresh', size: 14 }),
              t('market.auth.retry'),
            ),
          ),
        ),
        h(
          'p',
          { className: 'gb-foot' },
          h(Icon, { name: 'info', size: 12 }),
          t('market.auth.footnote'),
        ),
      )
    }

    function MarketErrorState(props) {
      const t = useT()
      const error = props.error || { message: '' }
      return h(
        'div',
        { className: 'gb-view' },
        h(
          'div',
          { className: 'gb-state is-error' },
          h('span', { className: 'gb-state-icon' }, h(Icon, { name: 'wifiOff', size: 25 })),
          h('h3', { className: 'gb-state-title' }, t('market.error.title')),
          h('p', { className: 'gb-state-desc' }, error.message),
          h('p', { className: 'gb-state-hint' }, t('market.error.hint')),
          h(
            'div',
            { className: 'gb-state-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'gb-btn gb-btn-accent',
                'data-gb-retry': 'market',
                onClick: () => props.onRetry(),
              },
              h(Icon, { name: 'refresh', size: 14 }),
              t('action.retry'),
            ),
            h(
              'button',
              { type: 'button', className: 'gb-btn', onClick: () => goto('library') },
              h(Icon, { name: 'grid', size: 14 }),
              t('action.backToLibrary'),
            ),
          ),
        ),
      )
    }

    function MarketView(props) {
      const t = useT()
      const s = props.state
      const [input, setInput] = React.useState(s.query || '')
      const debounceRef = React.useRef(null)
      const catalog = s.catalog
      const query = text(s.query).trim()
      const collection = text(s.collection)
      const isSearching = !!query || !!collection

      React.useEffect(() => {
        if (!s.market && !s.marketLoading && !s.marketError) loadMarket()
      }, [])

      React.useEffect(
        () => () => {
          if (debounceRef.current) clearTimeout(debounceRef.current)
        },
        [],
      )

      React.useEffect(() => {
        setInput(text(s.query))
      }, [s.query])

      const applySearch = (value, nextCollection) => {
        const nextQuery = text(value)
        const next = text(nextCollection)
        setState({ query: nextQuery, collection: next })
        runCatalog({ q: nextQuery, collection: next, offset: 0 })
      }

      const onInput = (event) => {
        const value = event.target.value
        setInput(value)
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null
          applySearch(value, '')
        }, 250)
      }

      const onClear = () => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        setInput('')
        applySearch('', '')
      }

      const collections = s.market && Array.isArray(s.market.collections) ? s.market.collections : []
      const authError = (s.marketError && s.marketError.code === 'AUTH') || (s.catalogError && s.catalogError.code === 'AUTH')
      const authState = !!authError
      const marketFailed = s.marketError && s.marketError.code !== 'AUTH'
      const activeCollection = collections.find((item) => item && item.id === collection) || null

      let status = 'market-home'
      if (authState) status = 'market-auth'
      else if (marketFailed) status = 'market-error'
      else if (s.marketLoading && !s.market) status = 'market-loading'
      else if (isSearching) {
        if (s.catalogError) status = s.catalogError.code === 'AUTH' ? 'market-auth' : 'market-error'
        else if (s.catalogLoading && !catalog) status = 'market-loading'
        else if (catalog && !catalog.items.length) status = 'market-empty'
        else status = 'market-results'
      }

      const toolbar = h(
        'div',
        { className: 'gb-market-bar' },
        h(
          'label',
          { className: 'gb-search' },
          h(Icon, { name: 'search', size: 15 }),
          h('input', {
            type: 'search',
            className: 'gb-search-input',
            'data-gb-search': '',
            value: input,
            placeholder: t('market.searchPlaceholder'),
            'aria-label': t('market.searchPlaceholder'),
            onChange: onInput,
          }),
          input
            ? h(
                'button',
                { type: 'button', className: 'gb-search-clear', 'aria-label': t('action.clear'), onClick: onClear },
                h(Icon, { name: 'close', size: 13 }),
              )
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'gb-btn gb-btn-sm gb-sync-btn',
            'data-gb-sync': '',
            disabled: s.syncBusy,
            onClick: () => syncMarket(),
          },
          s.syncBusy ? h(Spinner, { size: 13 }) : h(Icon, { name: 'refresh', size: 13 }),
          s.syncBusy ? t('settings.syncing') : t('market.syncNow'),
        ),
      )

      const chips = h(
        'div',
        { className: 'gb-chips', role: 'tablist', 'aria-label': t('market.collections') },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': !collection,
            className: cx('gb-chip', !collection && 'is-active'),
            'data-gb-collection': '',
            onClick: () => {
              if (debounceRef.current) clearTimeout(debounceRef.current)
              setInput('')
              applySearch('', '')
            },
          },
          t('market.all'),
        ),
        collections.map((item) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              key: item.id,
              'aria-selected': collection === item.id,
              className: cx('gb-chip', collection === item.id && 'is-active'),
              'data-gb-collection': item.id,
              title: text(item.description),
              onClick: () => {
                if (debounceRef.current) clearTimeout(debounceRef.current)
                setInput('')
                applySearch('', item.id)
              },
            },
            text(item.title),
            num(item.total, 0) ? h('span', { className: 'gb-chip-num' }, num(item.total, 0)) : null,
          ),
        ),
      )

      let body = null
      if (status === 'market-auth') {
        body = h(MarketAuthState)
      } else if (status === 'market-error') {
        body = h(MarketErrorState, {
          error: s.marketError || s.catalogError,
          onRetry: () => {
            if (s.marketError) loadMarket()
            else runCatalog({ q: s.query, collection: s.collection, offset: 0 })
          },
        })
      } else if (status === 'market-loading') {
        body = h(MarketSkeleton)
      } else if (isSearching) {
        const items = catalog && Array.isArray(catalog.items) ? catalog.items : []
        if (!items.length) {
          body = h('div', { className: 'gb-view' }, h(MarketEmpty, { query, collection }))
        } else {
          body = h(
            'div',
            { className: 'gb-view' },
            h(
              'div',
              { className: 'gb-section-head' },
              h(
                'h2',
                { className: 'gb-section-title' },
                activeCollection ? activeCollection.title : t('market.resultsFor', { q: query || '—' }),
              ),
              h('span', { className: 'gb-section-count' }, t('market.totalCount', { n: num(catalog && catalog.total, items.length) })),
            ),
            h('div', { className: 'gb-market-grid' }, items.map((game) => h(MarketCard, { key: game.id, game }))),
            h(LoadMore, { state: s }),
          )
        }
      } else {
        const featured = s.market && Array.isArray(s.market.featured) ? s.market.featured : []
        const items = catalog && Array.isArray(catalog.items) ? catalog.items : []
        body = h(
          'div',
          { className: 'gb-market-home' },
          !s.market && s.marketError ? null : null,
          featured.length
            ? h(MarketRail, { title: t('market.featured'), subtitle: t('market.featuredHint'), games: featured })
            : null,
          collections.map((item) =>
            h(MarketRail, {
              key: item.id,
              title: text(item.title),
              subtitle: text(item.description),
              games: Array.isArray(item.games) ? item.games : [],
            }),
          ),
          h(
            'div',
            { className: 'gb-section-head' },
            h('h2', { className: 'gb-section-title' }, t('market.allGames')),
            h('span', { className: 'gb-section-count' }, t('market.totalCount', { n: num(catalog && catalog.total, num(s.market && s.market.total, 0)) })),
          ),
          s.catalogError && s.catalogError.code !== 'AUTH'
            ? h(MarketErrorState, {
                error: s.catalogError,
                onRetry: () => runCatalog({ q: '', collection: '', offset: 0 }),
              })
            : s.catalogLoading && !items.length
              ? h(SkeletonGrid, { count: 12, compact: true })
              : h('div', { className: 'gb-market-grid' }, items.map((game) => h(MarketCard, { key: game.id, game }))),
          h(LoadMore, { state: s }),
          s.market && s.market.libraryVersion
            ? h(
                'p',
                { className: 'gb-foot' },
                h(Icon, { name: 'bag', size: 12 }),
                t('market.footnote', { version: text(s.market.libraryVersion) }),
              )
            : null,
        )
      }

      return h(
        'div',
        { className: 'gb-view gb-market', 'data-gb-status': status },
        toolbar,
        chips,
        body,
      )
    }

    function LoadMore(props) {
      const t = useT()
      const s = props.state
      const catalog = s.catalog
      if (!catalog) return null
      const items = Array.isArray(catalog.items) ? catalog.items : []
      if (!items.length || items.length >= num(catalog.total, items.length)) return null
      return h(
        'div',
        { className: 'gb-loadmore' },
        h(
          'button',
          {
            type: 'button',
            className: 'gb-btn gb-btn-lg',
            'data-gb-loadmore': '',
            disabled: s.catalogLoading,
            onClick: () =>
              runCatalog({
                q: catalog.q,
                collection: catalog.collection,
                offset: items.length,
                append: true,
              }),
          },
          s.catalogLoading ? h(Spinner, { size: 14 }) : h(Icon, { name: 'download', size: 14 }),
          s.catalogLoading ? t('action.loading') : t('action.loadMore'),
        ),
      )
    }

    /* ================================================================== *
     * 设置
     * ================================================================== */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': !!props.checked,
          className: cx('gb-switch', props.checked && 'is-on'),
          onClick: props.onChange,
          'data-gb-switch': props.id || '',
        },
        h('span', { className: 'gb-switch-track' }, h('span', { className: 'gb-switch-knob' })),
        h('span', { className: 'gb-switch-text' }, props.label),
      )
    }

    function authLabel(code) {
      const map = { settings: 'auth.settings', env: 'auth.env', gh: 'auth.gh', public: 'auth.public', none: 'auth.none' }
      return translate(map[text(code)] || 'auth.none')
    }

    function SettingsView(props) {
      const t = useT()
      const s = props.state
      const [token, setToken] = React.useState('')
      const [repo, setRepo] = React.useState('')
      const [tokenEdited, setTokenEdited] = React.useState(false)
      const settings = s.settings

      React.useEffect(() => {
        if (settings) setRepo(text(settings.repo))
      }, [settings && settings.repo])

      const status = s.status
      const market = status && status.market ? status.market : null
      const auth = market ? text(market.auth) : settings ? text(settings.tokenSource) : 'none'
      const dataDir = (settings && settings.dataDir) || (status && status.dataDir) || '—'
      const version = (status && status.version) || '—'
      const total = market ? num(market.catalogGames, 0) : 0
      const lastSync = market && market.lastSync ? timeText(market.lastSync) : t('settings.never')

      const saveToken = () =>
        saveSettings({ token }).then((saved) => {
          if (saved) {
            setToken('')
            setTokenEdited(false)
          }
        })
      const clearToken = () =>
        saveSettings({ token: '' }).then((saved) => {
          if (saved) {
            setToken('')
            setTokenEdited(false)
          }
        })
      const saveRepo = () => {
        const value = text(repo).trim()
        if (!/^[^\s/]+\/[^\s/]+$/.test(value)) {
          toast(translate('settings.repoInvalid'), 'error')
          return
        }
        saveSettings({ repo: value })
      }

      return h(
        'div',
        { className: 'gb-view gb-settings', 'data-gb-status': 'settings' },
        h(
          'section',
          { className: 'gb-panel' },
          h('h2', { className: 'gb-panel-title' }, t('settings.section.access')),
          h('p', { className: 'gb-panel-desc' }, t('settings.section.accessDesc')),
          h(
            'div',
            { className: 'gb-field' },
            h('label', { className: 'gb-field-label', htmlFor: 'gb-token' }, t('settings.token')),
            h(
              'div',
              { className: 'gb-field-row' },
              h('input', {
                id: 'gb-token',
                type: 'password',
                className: 'gb-input',
                'data-gb-token': '',
                value: token,
                autoComplete: 'off',
                placeholder: settings && settings.hasToken ? t('settings.tokenKeep') : 'github_pat_…',
                onChange: (event) => {
                  setToken(event.target.value)
                  setTokenEdited(true)
                },
              }),
              h(
                'button',
                { type: 'button', className: 'gb-btn gb-btn-accent', 'data-gb-save-token': '', disabled: s.settingsSaving, onClick: saveToken },
                s.settingsSaving ? h(Spinner, { size: 13 }) : h(Icon, { name: 'check', size: 13 }),
                t('action.save'),
              ),
              h(
                'button',
                { type: 'button', className: 'gb-btn', 'data-gb-clear-token': '', disabled: s.settingsSaving, onClick: clearToken },
                h(Icon, { name: 'trash', size: 13 }),
                t('action.clear'),
              ),
            ),
            h('p', { className: 'gb-field-hint' }, t('settings.tokenHint')),
          ),
          h(
            'div',
            { className: 'gb-field' },
            h('label', { className: 'gb-field-label', htmlFor: 'gb-repo' }, t('settings.repo')),
            h(
              'div',
              { className: 'gb-field-row' },
              h('input', {
                id: 'gb-repo',
                type: 'text',
                className: 'gb-input',
                'data-gb-repo': '',
                value: repo,
                spellCheck: false,
                placeholder: 'owner/name',
                onChange: (event) => setRepo(event.target.value),
              }),
              h(
                'button',
                { type: 'button', className: 'gb-btn', 'data-gb-save-repo': '', disabled: s.settingsSaving, onClick: saveRepo },
                h(Icon, { name: 'check', size: 13 }),
                t('action.save'),
              ),
            ),
            h('p', { className: 'gb-field-hint' }, t('settings.repoHint')),
          ),
        ),
        h(
          'section',
          { className: 'gb-panel' },
          h('h2', { className: 'gb-panel-title' }, t('settings.section.play')),
          h(
            'div',
            { className: 'gb-field' },
            h('label', { className: 'gb-field-label', htmlFor: 'gb-volume' }, t('settings.volume')),
            h(
              'div',
              { className: 'gb-field-row gb-slider-row' },
              h(Icon, { name: s.ui.muted ? 'mute' : 'volume', size: 16 }),
              h('input', {
                id: 'gb-volume',
                type: 'range',
                className: 'gb-range',
                min: 0,
                max: 1,
                step: 0.01,
                value: s.ui.volume,
                'data-gb-volume': '',
                onChange: (event) => setVolume(event.target.value),
              }),
              h('span', { className: 'gb-field-value' }, Math.round(s.ui.volume * 100) + '%'),
            ),
          ),
          h(
            'div',
            { className: 'gb-field' },
            h('span', { className: 'gb-field-label' }, t('settings.keys')),
            h(
              'div',
              { className: 'gb-seg', role: 'radiogroup', 'aria-label': t('settings.keys') },
              h(
                'button',
                {
                  type: 'button',
                  role: 'radio',
                  'aria-checked': s.ui.keys === 'default',
                  className: cx('gb-seg-btn', s.ui.keys === 'default' && 'is-active'),
                  'data-gb-keys': 'default',
                  onClick: () => setKeyScheme('default'),
                },
                t('settings.keys.default'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'radio',
                  'aria-checked': s.ui.keys === 'arcade',
                  className: cx('gb-seg-btn', s.ui.keys === 'arcade' && 'is-active'),
                  'data-gb-keys': 'arcade',
                  onClick: () => setKeyScheme('arcade'),
                },
                t('settings.keys.arcade'),
              ),
            ),
            h('p', { className: 'gb-field-hint' }, t('settings.keysHint')),
          ),
          h(
            'div',
            { className: 'gb-field' },
            h('span', { className: 'gb-field-label' }, t('settings.screen')),
            h(
              'div',
              { className: 'gb-seg', role: 'radiogroup', 'aria-label': t('settings.screen') },
              [
                ['fit', 'player.screen.fit'],
                ['stretch', 'player.screen.stretch'],
                ['pixel', 'player.screen.pixel'],
              ].map(([value, key]) =>
                h(
                  'button',
                  {
                    key: value,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': s.ui.screenMode === value,
                    className: cx('gb-seg-btn', s.ui.screenMode === value && 'is-active'),
                    'data-gb-screen-mode-setting': value,
                    onClick: () => setScreenMode(value),
                  },
                  t(key),
                ),
              ),
            ),
            h('p', { className: 'gb-field-hint' }, t('settings.screenHint')),
          ),
          h(
            'div',
            { className: 'gb-field gb-field-inline' },
            h(Switch, { id: 'crt', checked: s.ui.crt, onChange: toggleCrt, label: t('settings.crt') }),
            h(Switch, { id: 'fps', checked: s.ui.showFps, onChange: toggleShowFps, label: t('settings.fps') }),
          ),
        ),
        h(
          'section',
          { className: 'gb-panel' },
          h('h2', { className: 'gb-panel-title' }, t('settings.section.data')),
          h(
            'dl',
            { className: 'gb-meta-list' },
            h('div', { className: 'gb-meta-row' }, h('dt', null, t('settings.dataDir')), h('dd', { title: dataDir }, dataDir)),
            h('div', { className: 'gb-meta-row' }, h('dt', null, t('settings.auth')), h('dd', null, authLabel(auth))),
            h('div', { className: 'gb-meta-row' }, h('dt', null, t('settings.marketState')), h('dd', null, market && market.ready ? t('state.ready') : t('state.degraded'))),
            h('div', { className: 'gb-meta-row' }, h('dt', null, t('settings.catalogGames')), h('dd', null, total ? t('market.totalCount', { n: total }) : '—')),
            h('div', { className: 'gb-meta-row' }, h('dt', null, t('settings.lastSync')), h('dd', null, lastSync)),
            h('div', { className: 'gb-meta-row' }, h('dt', null, t('settings.version')), h('dd', null, version)),
          ),
        ),
        h(
          'section',
          { className: 'gb-panel' },
          h('h2', { className: 'gb-panel-title' }, t('settings.section.maintenance')),
          h('p', { className: 'gb-panel-desc' }, t('settings.syncDesc')),
          h(
            'button',
            {
              type: 'button',
              className: 'gb-btn gb-btn-accent',
              'data-gb-sync-settings': '',
              disabled: s.syncBusy,
              onClick: () => syncMarket(),
            },
            s.syncBusy ? h(Spinner, { size: 14 }) : h(Icon, { name: 'refresh', size: 14 }),
            s.syncBusy ? t('settings.syncing') : t('settings.sync'),
          ),
        ),
        h(
          'p',
          { className: 'gb-foot' },
          h(Icon, { name: 'info', size: 12 }),
          t('settings.footnote', { version }),
        ),
      )
    }

    /* ================================================================== *
     * 播放器
     * ================================================================== */
    function KeyHints() {
      const t = useT()
      const rows = [
        { keys: ['↑', '↓', '←', '→'], label: t('player.keys.move') },
        { keys: ['Z'], label: t('player.keys.b') },
        { keys: ['X'], label: t('player.keys.a') },
        { keys: ['Enter'], label: t('player.keys.start') },
        { keys: ['Shift'], label: t('player.keys.select') },
        { keys: ['Esc'], label: t('player.keys.escape') },
      ]
      return h(
        'div',
        { className: 'gb-keyhints', 'data-gb-keyhints': '' },
        rows.map((row) =>
          h(
            'span',
            { className: 'gb-keyhint', key: row.label },
            h(
              'span',
              { className: 'gb-keyhint-keys' },
              row.keys.map((key) => h('kbd', { key }, key)),
            ),
            h('span', { className: 'gb-keyhint-label' }, row.label),
          ),
        ),
      )
    }

    function TouchControls() {
      const press = (name) => (event) => {
        event.preventDefault()
        event.stopPropagation()
        try {
          if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        } catch {
          /* ignore */
        }
        setVirtualButton(name, true)
      }
      const release = (name) => (event) => {
        if (event) event.preventDefault()
        setVirtualButton(name, false)
      }
      const key = (name, label, className) =>
        h(
          'button',
          {
            type: 'button',
            className: cx('gb-touch-btn', className),
            'data-gb-touch-key': name,
            tabIndex: -1,
            onPointerDown: press(name),
            onPointerUp: release(name),
            onPointerCancel: release(name),
            onPointerLeave: release(name),
            onContextMenu: (event) => event.preventDefault(),
          },
          label,
        )
      return h(
        'div',
        { className: 'gb-touch', 'data-gb-touch': '' },
        h(
          'div',
          { className: 'gb-touch-dpad' },
          key('UP', '▲', 'dpad up'),
          key('LEFT', '◀', 'dpad left'),
          key('RIGHT', '▶', 'dpad right'),
          key('DOWN', '▼', 'dpad down'),
        ),
        h('div', { className: 'gb-touch-mid' }, key('SELECT', 'SELECT', 'pill'), key('START', 'START', 'pill')),
        h('div', { className: 'gb-touch-face' }, key('B', 'B', 'face b'), key('A', 'A', 'face a')),
      )
    }

    function SavePanel(props) {
      const t = useT()
      const s = props.state
      const mode = s.savePanel
      const saves = Array.isArray(s.saves) ? s.saves : []
      const [confirmSlot, setConfirmSlot] = React.useState('')
      React.useEffect(() => {
        setConfirmSlot('')
      }, [mode])
      return h(
        'div',
        { className: 'gb-saves', 'data-gb-save-panel': mode, role: 'dialog', 'aria-label': mode === 'save' ? t('player.save.title') : t('player.save.loadTitle') },
        h(
          'div',
          { className: 'gb-saves-head' },
          h('h3', null, mode === 'save' ? t('player.save.title') : t('player.save.loadTitle')),
          h(
            'button',
            { type: 'button', className: 'gb-icon-btn', 'aria-label': t('action.close'), onClick: () => setState({ savePanel: null }) },
            h(Icon, { name: 'close', size: 15 }),
          ),
        ),
        SAVE_SLOTS.map((slot) => {
          const record = saves.find((item) => item && item.slot === slot) || null
          const occupied = !!record
          const confirming = confirmSlot === slot
          return h(
            'div',
            { className: cx('gb-save-row', !occupied && 'is-empty'), key: slot, 'data-gb-slot': slot },
            h(
              'span',
              { className: 'gb-save-thumb' },
              record && record.thumb ? h('img', { src: record.thumb, alt: '' }) : h(Icon, { name: 'save', size: 15 }),
            ),
            h(
              'div',
              { className: 'gb-save-info' },
              h('span', { className: 'gb-save-name' }, slotText(slot)),
              h(
                'span',
                { className: 'gb-save-meta' },
                occupied
                  ? t('player.save.recordMeta', { time: timeText(record.updatedAt), duration: durationText(record.playSeconds) })
                  : t('player.save.empty'),
              ),
            ),
            mode === 'save'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: cx('gb-btn gb-btn-sm', confirming && 'is-danger'),
                    'data-gb-save-slot': slot,
                    onClick: () => {
                      if (occupied && !confirming) {
                        setConfirmSlot(slot)
                        return
                      }
                      setConfirmSlot('')
                      saveToSlot(slot)
                    },
                  },
                  confirming
                    ? t('player.save.confirmOverwrite')
                    : occupied
                      ? t('action.overwrite')
                      : t('action.save'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'gb-btn gb-btn-sm gb-btn-accent',
                    'data-gb-load-slot': slot,
                    disabled: !occupied,
                    onClick: () => loadFromSlot(slot),
                  },
                  h(Icon, { name: 'load', size: 12 }),
                  t('action.load'),
                ),
          )
        }),
        h(
          'p',
          { className: 'gb-saves-note' },
          mode === 'save' ? t('player.save.note') : t('player.save.loadNote'),
        ),
      )
    }

    function PlayerView(props) {
      const t = useT()
      const s = props.state
      const game = s.current
      const canvasRef = React.useRef(null)
      const stageRef = React.useRef(null)
      const screenRef = React.useRef(null)
      const [screen, setScreen] = React.useState({ w: 512, h: 384 })
      const [controlsHidden, setControlsHidden] = React.useState(false)

      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!game || !canvas) return undefined
        bootPlayer(canvas, game)
        return () => {
          teardownPlayer()
        }
      }, [game && game.id, s.playerNonce])

      React.useEffect(() => {
        const stage = stageRef.current
        if (!stage) return undefined
        const measure = () => {
          const rawW = Math.max(1, stage.clientWidth)
          const rawH = Math.max(1, stage.clientHeight)
          /* 全屏时不留边距；窗口内按短边 3% 留白（至少 12px），小窗口不会浪费空间 */
          const inFullscreen = !!document.fullscreenElement
          const pad = inFullscreen ? 0 : Math.max(12, Math.round(Math.min(rawW, rawH) * 0.03))
          const next = screenSizeFor(
            s.ui.screenMode,
            Math.max(1, rawW - pad * 2),
            Math.max(1, rawH - pad * 2),
          )
          setScreen((previous) => (previous.w === next.w && previous.h === next.h ? previous : next))
        }
        measure()
        let observer = null
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure)
          observer.observe(stage)
        }
        window.addEventListener('resize', measure)
        return () => {
          if (observer) {
            try {
              observer.disconnect()
            } catch {
              /* ignore */
            }
          }
          window.removeEventListener('resize', measure)
        }
      }, [game && game.id, s.fullscreen, s.ui.screenMode])

      /* 全屏时控制条自动隐藏：2.5s 无操作淡出，移动/按键/触摸再现 */
      React.useEffect(() => {
        if (!s.fullscreen) {
          setControlsHidden(false)
          return undefined
        }
        let timer = null
        let hidden = false
        const reveal = () => {
          if (hidden) {
            hidden = false
            setControlsHidden(false)
          }
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            hidden = true
            setControlsHidden(true)
          }, 2500)
        }
        reveal()
        const events = ['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart']
        events.forEach((name) => window.addEventListener(name, reveal, { passive: true }))
        return () => {
          if (timer) clearTimeout(timer)
          events.forEach((name) => window.removeEventListener(name, reveal))
        }
      }, [s.fullscreen])

      if (!game) return null

      const phase = s.playerPhase
      const paused = !!s.engineState.paused
      const audioBlocked = s.engineState.audio === 'blocked' && s.audioReady
      const screenStyle = { width: screen.w + 'px', height: screen.h + 'px' }

      const screenChildren = [
        h('canvas', {
          key: 'canvas',
          ref: canvasRef,
          className: 'gb-canvas',
          'data-gb-canvas': '',
          width: FRAME_W,
          height: FRAME_H,
        }),
        s.ui.crt
          ? h('span', { key: 'crt', className: 'gb-crt-overlay', 'data-gb-crt': '', 'aria-hidden': 'true' })
          : null,
        phase === 'boot'
          ? h(
              'div',
              { key: 'boot', className: 'gb-screen-veil' },
              h(Spinner, { size: 22 }),
              h('span', { className: 'gb-veil-title' }, t('player.bootTitle')),
              h('span', { className: 'gb-veil-sub' }, t('player.bootHint')),
            )
          : null,
        phase === 'error'
          ? h(
              'div',
              { key: 'error', className: 'gb-screen-veil is-error' },
              h(Icon, { name: 'info', size: 24 }),
              h('span', { className: 'gb-veil-title' }, t('player.errorTitle')),
              h('span', { className: 'gb-veil-sub' }, (s.playerError && s.playerError.message) || t('error.unknown')),
              h(
                'div',
                { className: 'gb-veil-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gb-btn gb-btn-accent gb-btn-sm',
                    'data-gb-retry': 'player',
                    onClick: () => setState({ playerNonce: num(state.playerNonce, 0) + 1 }),
                  },
                  h(Icon, { name: 'refresh', size: 13 }),
                  t('action.retry'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'gb-btn gb-btn-sm', onClick: exitPlayer },
                  t('action.backToLibrary'),
                ),
              ),
            )
          : null,
        phase === 'ready' && !s.audioReady
          ? h(
              'button',
              {
                key: 'start',
                type: 'button',
                className: 'gb-start-overlay',
                'data-gb-start': '',
                onClick: startAudio,
              },
              h('span', { className: 'gb-start-pad' }, h(PixelPad, { size: Math.max(40, Math.min(92, Math.round(Math.min(screen.w, screen.h) * 0.2))) })),
              h('span', { className: 'gb-start-title' }, t('player.startOverlay')),
              h('span', { className: 'gb-start-hint' }, t('player.startHint')),
              h('span', { className: 'gb-start-blink' }, t('player.pressStart')),
            )
          : null,
        phase === 'ready' && s.audioReady && paused
          ? h(
              'button',
              {
                key: 'paused',
                type: 'button',
                className: 'gb-screen-veil is-paused',
                'data-gb-pause-veil': '',
                onClick: resumeGame,
              },
              h(Icon, { name: 'pause', size: 26 }),
              h('span', { className: 'gb-veil-title' }, t('player.paused')),
              h('span', { className: 'gb-veil-sub' }, s.mediaConflict ? t('player.mediaPaused') : t('player.pausedHint')),
            )
          : null,
        s.ui.showFps && phase === 'ready'
          ? h('span', { key: 'fps', className: 'gb-fps', 'data-gb-fps': '' }, Math.round(s.engineState.fps) + ' FPS')
          : null,
      ]

      return h(
        'section',
        {
          className: cx('gb-player', s.ui.crt && 'is-crt', controlsHidden && 'is-controls-hidden'),
          'data-gb-player': '',
          'data-gb-phase': phase,
          'data-gb-status':
            phase === 'error'
              ? 'player-error'
              : phase === 'boot'
                ? 'player-boot'
                : !s.audioReady
                  ? 'player-ready'
                  : paused
                    ? 'player-paused'
                    : 'player-playing',
        },
        h(
          'div',
          { className: 'gb-player-top' },
          h(
            'button',
            {
              type: 'button',
              className: 'gb-btn gb-btn-sm gb-btn-ghost',
              'data-gb-back': '',
              onClick: exitPlayer,
            },
            h(Icon, { name: 'back', size: 15 }),
            h('span', null, t('action.backToLibrary')),
          ),
          h(
            'div',
            { className: 'gb-nameplate' },
            h('span', { className: 'gb-nameplate-label' }, t('player.nowPlaying')),
            h('span', { className: 'gb-nameplate-title', title: text(game.title) }, text(game.title)),
            game.builtin
              ? h(Badge, { tone: 'red' }, t('library.builtin'))
              : h(Badge, { tone: 'gold' }, t('library.downloaded')),
          ),
          h(
            'div',
            { className: 'gb-player-top-right' },
            audioBlocked
              ? h('span', { className: 'gb-chip gb-chip-warn', 'data-gb-audio-blocked': '' }, h(Icon, { name: 'mute', size: 12 }), t('player.audioBlockedShort'))
              : null,
            s.gamepadConnected ? h('span', { className: 'gb-chip gb-chip-quiet' }, h(Icon, { name: 'keys', size: 12 }), t('player.gamepad')) : null,
            h(
              'button',
              {
                type: 'button',
                className: 'gb-icon-btn',
                'data-gb-fullscreen': '',
                title: s.fullscreen ? t('player.exitFullscreen') : t('player.fullscreen'),
                'aria-label': s.fullscreen ? t('player.exitFullscreen') : t('player.fullscreen'),
                onClick: toggleFullscreen,
              },
              h(Icon, { name: s.fullscreen ? 'minimize' : 'fullscreen', size: 16 }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'gb-player-stage', ref: stageRef },
          h('div', { className: 'gb-screen', 'data-gb-stage': '', ref: screenRef, style: screenStyle }, screenChildren),
        ),
        s.touchMode && phase === 'ready' ? h(TouchControls) : null,
        h(
          'div',
          { className: 'gb-player-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'gb-icon-btn gb-play-btn',
              'data-gb-pause': '',
              title: paused ? t('action.resumePlay') : t('action.pause'),
              'aria-label': paused ? t('action.resumePlay') : t('action.pause'),
              onClick: togglePause,
            },
            h(Icon, { name: paused ? 'play' : 'pause', size: 18 }),
          ),
          h(
            'button',
            { type: 'button', className: 'gb-icon-btn', 'data-gb-reset': '', title: t('action.reset'), 'aria-label': t('action.reset'), onClick: resetGame },
            h(Icon, { name: 'reset', size: 16 }),
          ),
          h('span', { className: 'gb-bar-sep' }),
          h(
            'button',
            {
              type: 'button',
              className: cx('gb-icon-btn', s.savePanel === 'save' && 'is-on'),
              'data-gb-save': '',
              title: t('player.save.title'),
              'aria-label': t('player.save.title'),
              onClick: () => toggleSavePanel('save'),
            },
            h(Icon, { name: 'save', size: 16 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('gb-icon-btn', s.savePanel === 'load' && 'is-on'),
              'data-gb-load': '',
              title: t('player.save.loadTitle'),
              'aria-label': t('player.save.loadTitle'),
              onClick: () => toggleSavePanel('load'),
            },
            h(Icon, { name: 'load', size: 16 }),
          ),
          h('span', { className: 'gb-bar-sep' }),
          h(
            'div',
            { className: 'gb-bar-volume' },
            h(
              'button',
              {
                type: 'button',
                className: 'gb-icon-btn',
                'data-gb-mute': '',
                title: s.ui.muted ? t('player.unmute') : t('player.mute'),
                'aria-label': s.ui.muted ? t('player.unmute') : t('player.mute'),
                onClick: toggleMute,
              },
              h(Icon, { name: s.ui.muted ? 'mute' : 'volume', size: 16 }),
            ),
            h('input', {
              type: 'range',
              className: 'gb-range gb-range-player',
              min: 0,
              max: 1,
              step: 0.01,
              value: s.ui.muted ? 0 : s.ui.volume,
              'data-gb-volume': '',
              'aria-label': t('player.volume'),
              onChange: (event) => setVolume(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'gb-seg gb-seg-sm', role: 'group', 'aria-label': t('player.speed') },
            [0.5, 1, 2].map((value) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: cx('gb-seg-btn', s.ui.speed === value && 'is-active'),
                  'data-gb-speed': String(value),
                  onClick: () => setSpeed(value),
                },
                value + '×',
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'gb-icon-btn gb-screen-mode-btn',
              'data-gb-screen-mode': s.ui.screenMode,
              title: t('player.screenModeTitle', { mode: t('player.screen.' + s.ui.screenMode) }),
              'aria-label': t('player.screenModeTitle', { mode: t('player.screen.' + s.ui.screenMode) }),
              onClick: () => cycleScreenMode(),
            },
            h(Icon, {
              name: s.ui.screenMode === 'stretch' ? 'fullscreen' : s.ui.screenMode === 'pixel' ? 'grid' : 'ratio',
              size: 16,
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('gb-icon-btn', s.ui.crt && 'is-on'),
              'data-gb-crt-toggle': '',
              title: t('player.crt'),
              'aria-label': t('player.crt'),
              onClick: toggleCrt,
            },
            h(Icon, { name: 'crt', size: 16 }),
          ),
          h(
            'button',
            { type: 'button', className: 'gb-icon-btn', 'data-gb-screenshot': '', title: t('player.screenshot'), 'aria-label': t('player.screenshot'), onClick: screenshot },
            h(Icon, { name: 'camera', size: 16 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('gb-icon-btn', s.keyHintsOpen && 'is-on'),
              'data-gb-keys-toggle': '',
              title: t('player.keys'),
              'aria-label': t('player.keys'),
              onClick: toggleKeyHints,
            },
            h(Icon, { name: 'keys', size: 16 }),
          ),
          h('span', { className: 'gb-bar-spacer' }),
          s.ui.showFps ? h('span', { className: 'gb-fps gb-fps-bar', 'data-gb-fps-bar': '' }, Math.round(s.engineState.fps) + ' FPS') : null,
          h(
            'button',
            { type: 'button', className: 'gb-btn gb-btn-sm gb-btn-ghost', 'data-gb-back-bar': '', onClick: exitPlayer },
            h('span', null, t('action.backToLibrary')),
          ),
        ),
        s.keyHintsOpen ? h(KeyHints) : null,
        s.savePanel ? h(SavePanel, { state: s }) : null,
      )
    }

    /* ================================================================== *
     * 页面根
     * ================================================================== */
    function Page() {
      const s = useStore()
      const t = useT()

      React.useEffect(() => {
        const apply = () => {
          let coarse = false
          let narrow = false
          try {
            coarse = window.matchMedia('(pointer: coarse)').matches
            narrow = window.matchMedia('(max-width: 860px)').matches
          } catch {
            coarse = false
            narrow = false
          }
          setState({ touchMode: !!(coarse || narrow) })
        }
        apply()
        let mq1 = null
        let mq2 = null
        try {
          mq1 = window.matchMedia('(pointer: coarse)')
          mq2 = window.matchMedia('(max-width: 860px)')
          if (mq1.addEventListener) {
            mq1.addEventListener('change', apply)
            mq2.addEventListener('change', apply)
          } else if (mq1.addListener) {
            mq1.addListener(apply)
            mq2.addListener(apply)
          }
        } catch {
          /* ignore */
        }
        return () => {
          try {
            if (mq1 && mq2) {
              if (mq1.removeEventListener) {
                mq1.removeEventListener('change', apply)
                mq2.removeEventListener('change', apply)
              } else if (mq1.removeListener) {
                mq1.removeListener(apply)
                mq2.removeListener(apply)
              }
            }
          } catch {
            /* ignore */
          }
        }
      }, [])

      const view = s.view === 'player' && !s.current ? 'library' : s.view
      if (s.view === 'player' && s.current) {
        return h(
          'div',
          { className: 'gb-root is-player', 'data-gb': 'root', 'data-gb-view': 'player' },
          h(PlayerView, { state: s }),
          s.toast ? h(Toast, { toast: s.toast }) : null,
        )
      }
      return h(
        'div',
        { className: 'gb-root', 'data-gb': 'root', 'data-gb-view': view },
        h(Header, { state: s }),
        h(Tabs, { state: s }),
        h(
          'div',
          { className: 'gb-scroll' },
          h(
            'div',
            { className: 'gb-wrap' },
            view === 'market'
              ? h(MarketView, { state: s })
              : view === 'settings'
                ? h(SettingsView, { state: s })
                : h(LibraryView, { state: s }),
          ),
        ),
        s.toast ? h(Toast, { toast: s.toast }) : null,
      )
    }

    /* ================================================================== *
     * 样式：容器/文字/边框全部从 DSH 主题 token 派生；游戏画面允许自有颜色
     * ================================================================== */
    const CSS = `
    .gb-root{
      --gb-t1:var(--dsw-alias-label-primary,#1d1d1f);
      --gb-t2:var(--dsw-alias-label-secondary,#6e6e73);
      --gb-t3:var(--dsw-alias-label-tertiary,#8e8e93);
      --gb-bg:var(--dsw-alias-bg-base,#ffffff);
      --gb-l1:var(--dsw-alias-bg-layer-1,#f5f5f7);
      --gb-l2:var(--dsw-alias-bg-layer-2,#ffffff);
      --gb-line:var(--dsw-alias-border-l1,rgba(0,0,0,.10));
      --gb-line2:var(--dsw-alias-border-l2,rgba(0,0,0,.06));
      --gb-fill:color-mix(in srgb,var(--gb-t1) 5%,transparent);
      --gb-fill2:color-mix(in srgb,var(--gb-t1) 9%,transparent);
      --gb-accent:#2563eb;
      --gb-accent-hi:#60a5fa;
      --gb-gold:#f5b731;
      --gb-cream:#eef4ff;
      --gb-success:var(--dsw-alias-state-success-primary,#2fbf71);
      --gb-error:var(--dsw-alias-state-error-primary,#e5534b);
      --gb-warn:var(--dsw-alias-state-warning-primary,#e59a2b);
      --gb-shadow-1:0 1px 2px rgba(20,12,14,.05),0 16px 40px -30px rgba(20,12,14,.4);
      --gb-shadow-2:0 2px 6px rgba(20,12,14,.06),0 28px 60px -34px rgba(20,12,14,.45);
      --gb-r-xl:24px;
      --gb-r-lg:18px;
      --gb-r-md:13px;
      --gb-r-sm:9px;
      position:relative;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
      color:var(--gb-t1);font-size:13px;line-height:1.5;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Helvetica Neue","Segoe UI",sans-serif;
      -webkit-font-smoothing:antialiased;
      background:
        radial-gradient(1100px 460px at 6% -14%,color-mix(in srgb,var(--gb-accent) 9%,transparent),transparent 64%),
        radial-gradient(900px 420px at 100% -8%,color-mix(in srgb,var(--gb-gold) 8%,transparent),transparent 68%);
    }
    .gb-root *,.gb-root *::before,.gb-root *::after{box-sizing:border-box}
    .gb-root button{font:inherit;color:inherit;cursor:pointer}
    .gb-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--gb-accent));outline-offset:2px}
    .gb-root img{max-width:100%}
    .gb-ico{display:block;flex:none}
    .gb-pad-art{display:block;flex:none}
    .gb-ico.is-spinning{animation:gb-spin .85s linear infinite}

    /* ---------------------- 顶栏 ---------------------- */
    .gb-head{
      display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
      padding:14px 28px 10px;flex:none;
    }
    .gb-brand{display:flex;align-items:center;gap:12px;min-width:0}
    .gb-brand-mark{
      display:grid;place-items:center;flex:none;width:46px;height:46px;border-radius:15px;
      background:transparent;
      box-shadow:0 10px 22px -16px rgba(20,16,40,.55);
    }
    .gb-brand-text{min-width:0}
    .gb-brand-title{margin:0;font-size:21px;font-weight:760;letter-spacing:-.02em;line-height:1.2}
    .gb-brand-sub{margin:2px 0 0;font-size:11.5px;color:var(--gb-t2);letter-spacing:.02em}
    .gb-head-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .gb-chip{
      display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;
      border:1px solid var(--gb-line);background:color-mix(in srgb,var(--gb-l1) 60%,transparent);
      font-size:10.5px;font-weight:650;color:var(--gb-t2);white-space:nowrap;letter-spacing:.01em;
    }
    .gb-chip-quiet{background:transparent;border-color:var(--gb-line2)}
    .gb-chip-warn{color:var(--gb-warn);border-color:color-mix(in srgb,var(--gb-warn) 36%,transparent);background:color-mix(in srgb,var(--gb-warn) 10%,transparent)}
    .gb-chip-num{font-size:9.5px;opacity:.7}
    .gb-icon-btn{
      display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:999px;
      border:1px solid transparent;background:transparent;color:var(--gb-t2);flex:none;
      transition:background 150ms ease,color 150ms ease,transform 150ms ease;
    }
    .gb-icon-btn:hover{background:var(--gb-fill);color:var(--gb-t1)}
    .gb-icon-btn:active{transform:scale(.94)}
    .gb-icon-btn.is-on{color:var(--gb-accent)}
    .gb-btn{
      display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 15px;
      border-radius:999px;border:1px solid var(--gb-line);
      background:color-mix(in srgb,var(--gb-l2) 72%,transparent);color:var(--gb-t1);
      font-size:12.5px;font-weight:660;letter-spacing:-.01em;white-space:nowrap;
      transition:background 150ms ease,border-color 150ms ease,transform 150ms ease,filter 150ms ease;
    }
    .gb-btn:hover{background:var(--gb-fill2)}
    .gb-btn:active{transform:scale(.97)}
    .gb-btn:disabled{opacity:.55;cursor:default;transform:none}
    .gb-btn-accent{
      border-color:transparent;color:#fff8ee;
      background:linear-gradient(135deg,var(--gb-accent),#1e40af);
      box-shadow:0 12px 24px -16px color-mix(in srgb,var(--gb-accent) 80%,transparent);
    }
    .gb-btn-accent:hover{filter:brightness(1.06)}
    .gb-btn-accent:disabled{filter:grayscale(.2)}
    .gb-btn-lg{height:40px;padding:0 20px;font-size:13px}
    .gb-btn-sm{height:29px;padding:0 11px;font-size:11.5px;gap:5px}
    .gb-btn-block{width:100%}
    .gb-btn.is-danger,.gb-menu-item.is-danger{color:var(--gb-error)}
    .gb-btn-ghost{background:transparent;border-color:transparent}
    .gb-btn-ghost:hover{background:var(--gb-fill)}

    /* ---------------------- Tabs ---------------------- */
    .gb-tabs{display:flex;align-items:center;gap:6px;padding:2px 28px 8px;flex:none;flex-wrap:wrap}
    .gb-tab{
      display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 15px;border-radius:999px;
      border:1px solid transparent;background:transparent;color:var(--gb-t2);
      font-size:13px;font-weight:660;letter-spacing:-.01em;
      transition:background 150ms ease,color 150ms ease,border-color 150ms ease;
    }
    .gb-tab:hover{background:var(--gb-fill);color:var(--gb-t1)}
    .gb-tab.is-active{
      color:var(--gb-t1);background:var(--gb-l2);border-color:var(--gb-line);
      box-shadow:var(--gb-shadow-1);
    }
    .gb-tab.is-active::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gb-accent)}
    .gb-tab-count{
      font-size:9.5px;font-weight:700;color:var(--gb-t3);background:var(--gb-fill);
      padding:1px 6px;border-radius:999px;letter-spacing:0;
    }

    /* ---------------------- 滚动容器 ---------------------- */
    .gb-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin}
    .gb-wrap{max-width:1440px;margin:0 auto;padding:8px 28px 34px}
    .gb-view{display:flex;flex-direction:column;gap:18px;animation:gb-fade 220ms ease}
    .gb-foot{
      display:flex;align-items:center;justify-content:center;gap:7px;flex-wrap:wrap;
      color:var(--gb-t3);font-size:10.5px;letter-spacing:.01em;padding:16px 0 2px;text-align:center;
    }
    .gb-section-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-top:2px}
    .gb-section-title{margin:0;font-size:15.5px;font-weight:740;letter-spacing:-.01em}
    .gb-section-count{font-size:11px;color:var(--gb-t3);font-weight:600}
    .gb-dot{margin:0 7px;opacity:.5}

    /* ---------------------- Hero ---------------------- */
    .gb-hero{
      position:relative;display:flex;align-items:center;gap:20px;min-height:196px;
      padding:26px 30px;border-radius:var(--gb-r-xl);overflow:hidden;
      border:1px solid var(--gb-line);
      background:
        radial-gradient(560px 260px at 84% 16%,color-mix(in srgb,var(--gb-gold) 18%,transparent),transparent 64%),
        linear-gradient(116deg,color-mix(in srgb,var(--gb-accent) 13%,var(--gb-l2)) 0%,color-mix(in srgb,var(--gb-accent) 5%,var(--gb-l2)) 42%,color-mix(in srgb,var(--gb-gold) 11%,var(--gb-l2)) 100%);
      box-shadow:var(--gb-shadow-1);
    }
    .gb-hero-body{position:relative;z-index:2;display:flex;flex-direction:column;gap:9px;min-width:0;flex:1}
    .gb-hero-eyebrow{
      display:inline-flex;align-items:center;gap:6px;align-self:flex-start;
      font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
      color:color-mix(in srgb,var(--gb-accent) 58%,var(--gb-t1));
      padding:3px 9px;border-radius:999px;
      background:color-mix(in srgb,var(--gb-accent) 10%,transparent);
      border:1px solid color-mix(in srgb,var(--gb-accent) 22%,transparent);
    }
    .gb-hero-title{margin:0;font-size:29px;font-weight:780;letter-spacing:-.02em;line-height:1.15}
    .gb-hero-meta{margin:0;font-size:12px;color:var(--gb-t2);display:flex;align-items:center;flex-wrap:wrap}
    .gb-hero-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
    .gb-hero-art{
      position:relative;z-index:2;flex:none;display:grid;place-items:center;
      filter:drop-shadow(0 22px 34px rgba(120,8,24,.42));
      transform:rotate(-6deg);
    }
    .gb-hero-bg{
      position:absolute;right:-9%;top:-42%;bottom:-42%;width:52%;z-index:0;
      opacity:.46;filter:blur(26px) saturate(1.2);
      -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 52%);
      mask-image:linear-gradient(90deg,transparent 0,#000 52%);
    }
    .gb-hero-bg .gb-cover{width:100%;height:100%;border-radius:0}
    .gb-hero-bg .gb-cover-scan{display:none}

    /* ---------------------- 游戏库网格 ---------------------- */
    .gb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 16px}
    @media (min-width:520px){.gb-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media (min-width:700px){.gb-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media (min-width:900px){.gb-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
    @media (min-width:1100px){.gb-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}
    .gb-card{position:relative;min-width:0}
    .gb-card-hit{display:block;width:100%;padding:0;border:0;background:none;text-align:left;border-radius:var(--gb-r-md)}
    .gb-card-cover{
      position:relative;display:block;aspect-ratio:4/5;border-radius:var(--gb-r-md);overflow:hidden;
      background:var(--gb-l1);border:1px solid var(--gb-line2);
      box-shadow:var(--gb-shadow-1);
      transition:transform 200ms ease,box-shadow 200ms ease,border-color 200ms ease;
    }
    .gb-card:hover .gb-card-cover,.gb-card-hit:focus-visible .gb-card-cover{
      transform:translateY(-4px);box-shadow:var(--gb-shadow-2);border-color:color-mix(in srgb,var(--gb-accent) 26%,transparent);
    }
    .gb-cover{position:relative;width:100%;height:100%;overflow:hidden;background:var(--gb-l1)}
    .gb-cover-img{width:100%;height:100%;object-fit:cover;display:block}
    .gb-cover-scan{
      position:absolute;inset:0;pointer-events:none;
      background:repeating-linear-gradient(0deg,rgba(0,0,0,.07) 0 1px,rgba(0,0,0,0) 1px 3px);
      opacity:.55;
    }
    .gb-cover.is-fallback{display:grid;place-items:center}
    .gb-cover-initial{display:flex;align-items:center;justify-content:center;width:100%;height:100%}
    .gb-cover-initial-glyph{
      font-size:clamp(26px,3.4vw,40px);font-weight:800;color:rgba(255,248,236,.94);
      text-shadow:0 2px 0 rgba(0,0,0,.28),0 10px 22px rgba(0,0,0,.3);letter-spacing:-.02em;
      font-family:ui-monospace,"SF Mono",Menlo,monospace;
    }
    .gb-cover-initial-pixel{
      position:absolute;inset:0;
      background:
        radial-gradient(circle at 22% 24%,rgba(255,255,255,.16),transparent 42%),
        repeating-linear-gradient(45deg,rgba(0,0,0,.06) 0 2px,transparent 2px 8px);
    }
    .gb-card-badges{position:absolute;top:7px;left:7px;right:7px;display:flex;gap:5px;flex-wrap:wrap;z-index:2}
    .gb-badge{
      display:inline-flex;align-items:center;gap:3px;height:19px;padding:0 6px;border-radius:6px;
      font-size:9.5px;font-weight:750;letter-spacing:.02em;color:#fff8ee;
      background:rgba(24,10,16,.66);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
      border:1px solid rgba(255,255,255,.14);white-space:nowrap;
    }
    .gb-badge.is-red{background:linear-gradient(135deg,rgba(37,99,235,.94),rgba(139,10,30,.94));border-color:transparent}
    .gb-badge.is-gold{background:linear-gradient(135deg,rgba(196,138,18,.95),rgba(150,96,8,.95));border-color:transparent}
    .gb-badge.is-quiet{background:rgba(24,16,22,.55);color:#fff;opacity:.92}
    .gb-card-play{
      position:absolute;left:8px;right:8px;bottom:8px;z-index:2;
      display:flex;align-items:center;justify-content:center;gap:5px;height:32px;border-radius:9px;
      background:linear-gradient(135deg,var(--gb-accent),rgba(163,10,37,.96));color:#fff8ee;
      font-size:11.5px;font-weight:720;letter-spacing:.01em;
      opacity:0;transform:translateY(6px);
      transition:opacity 170ms ease,transform 170ms ease;
      box-shadow:0 12px 22px -14px rgba(0,0,0,.7);
    }
    .gb-card:hover .gb-card-play,.gb-card-hit:focus-visible .gb-card-play{opacity:1;transform:none}
    .gb-card-info{display:flex;flex-direction:column;gap:2px;padding:9px 2px 0;min-width:0}
    .gb-card-title{font-size:13px;font-weight:680;letter-spacing:-.01em;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gb-card-sub{font-size:10.5px;color:var(--gb-t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gb-card-menu{position:absolute;top:6px;right:6px;z-index:5}
    .gb-card-menu-btn{width:28px;height:28px;background:rgba(16,10,14,.55);color:#fff;opacity:.72;backdrop-filter:blur(6px)}
    .gb-card:hover .gb-card-menu-btn,.gb-card.is-menu-open .gb-card-menu-btn{opacity:1}
    .gb-card-menu-btn:hover{background:rgba(16,10,14,.78);color:#fff}
    .gb-menu{
      position:absolute;top:32px;right:0;width:236px;padding:8px;border-radius:12px;
      background:var(--gb-l2);border:1px solid var(--gb-line);box-shadow:var(--gb-shadow-2);
      z-index:12;animation:gb-pop 140ms ease;
    }
    .gb-menu-item{
      display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:8px;
      background:transparent;font-size:12px;font-weight:620;text-align:left;
    }
    .gb-menu-item:hover{background:var(--gb-fill)}
    .gb-menu-confirm{padding:4px 4px 2px}
    .gb-menu-confirm p{margin:0 0 8px;font-size:11.5px;color:var(--gb-t2);line-height:1.45}
    .gb-menu-confirm-actions{display:flex;gap:6px;justify-content:flex-end}
    .gb-menu-note{margin:8px 0 0!important;font-size:10px!important;color:var(--gb-t3)!important}
    .gb-skeleton{cursor:default;display:flex;flex-direction:column;gap:8px}
    .gb-skeleton-cover{
      display:block;aspect-ratio:4/5;border-radius:var(--gb-r-md);
      background:linear-gradient(100deg,var(--gb-l1) 20%,var(--gb-fill2) 42%,var(--gb-l1) 62%);
      background-size:220% 100%;animation:gb-shimmer 1.5s ease-in-out infinite;
    }
    .gb-skeleton-line{display:block;height:11px;border-radius:5px;background:var(--gb-fill2);opacity:.7;width:84%}
    .gb-skeleton-line.short{width:52%}
    .gb-skeleton-line.title{width:140px;height:15px}
    .gb-skeleton-card{width:150px;flex:none}
    .gb-grid.is-compact{grid-template-columns:repeat(auto-fill,minmax(126px,1fr))}

    /* ---------------------- 市场 ---------------------- */
    .gb-market-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .gb-search{
      display:flex;align-items:center;gap:8px;flex:1;min-width:220px;max-width:520px;
      height:38px;padding:0 12px;border-radius:999px;border:1px solid var(--gb-line);
      background:color-mix(in srgb,var(--gb-l2) 70%,transparent);color:var(--gb-t3);
      transition:border-color 150ms ease,box-shadow 150ms ease;
    }
    .gb-search:focus-within{border-color:color-mix(in srgb,var(--gb-accent) 34%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-accent) 10%,transparent)}
    .gb-search-input{
      flex:1;min-width:0;height:100%;border:0;background:transparent;outline:none;
      font:inherit;font-size:12.5px;color:var(--gb-t1);
    }
    .gb-search-input::placeholder{color:var(--gb-t3)}
    .gb-search-clear{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;border:0;background:var(--gb-fill2);color:var(--gb-t2);padding:0}
    .gb-sync-btn{flex:none}
    .gb-chips{
      display:flex;gap:6px;overflow-x:auto;padding:2px 2px 6px;
      scrollbar-width:thin;scroll-snap-type:x proximity;
    }
    .gb-chips::-webkit-scrollbar{height:4px}
    .gb-chip{
      flex:none;display:inline-flex;align-items:center;gap:5px;height:29px;padding:0 12px;border-radius:999px;
      border:1px solid var(--gb-line2);background:transparent;color:var(--gb-t2);
      font-size:11.5px;font-weight:640;white-space:nowrap;scroll-snap-align:start;
      transition:background 150ms ease,color 150ms ease,border-color 150ms ease;
    }
    .gb-chip:hover{background:var(--gb-fill);color:var(--gb-t1)}
    .gb-chip.is-active{background:var(--gb-t1);color:var(--gb-bg);border-color:var(--gb-t1);font-weight:700}
    .gb-rail{display:flex;flex-direction:column;gap:8px}
    .gb-rail-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
    .gb-rail-title{margin:0;font-size:13.5px;font-weight:730;letter-spacing:-.01em}
    .gb-rail-sub{font-size:10.5px;color:var(--gb-t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gb-rail-scroll{
      display:flex;gap:12px;overflow-x:auto;padding:2px 2px 10px;
      scrollbar-width:thin;scroll-snap-type:x proximity;
    }
    .gb-rail-scroll::-webkit-scrollbar{height:5px}
    .gb-market-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 14px}
    @media (min-width:520px){.gb-market-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media (min-width:720px){.gb-market-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media (min-width:960px){.gb-market-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
    @media (min-width:1200px){.gb-market-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}
    .gb-market-card{
      display:flex;flex-direction:column;gap:0;min-width:0;
      border-radius:var(--gb-r-md);border:1px solid var(--gb-line2);overflow:hidden;
      background:var(--gb-l2);transition:transform 180ms ease,box-shadow 180ms ease,border-color 180ms ease;
    }
    .gb-rail .gb-market-card{width:138px;flex:none;scroll-snap-align:start}
    .gb-market-card:hover{transform:translateY(-3px);box-shadow:var(--gb-shadow-2);border-color:var(--gb-line)}
    .gb-market-cover{position:relative;aspect-ratio:4/5;background:var(--gb-l1);overflow:hidden}
    .gb-market-badges{position:absolute;top:6px;left:6px;right:6px;display:flex;gap:4px;flex-wrap:wrap;z-index:2}
    .gb-market-info{display:flex;flex-direction:column;gap:5px;padding:8px;min-width:0}
    .gb-market-title{font-size:11.5px;font-weight:660;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gb-market-meta{font-size:9.5px;color:var(--gb-t3);letter-spacing:.01em}
    .gb-inline-error{margin:0;font-size:10px;color:var(--gb-error);line-height:1.35}
    .gb-progress{display:block;height:3px;border-radius:999px;background:var(--gb-fill2);overflow:hidden}
    .gb-progress-bar{
      display:block;width:40%;height:100%;border-radius:999px;
      background:linear-gradient(90deg,var(--gb-accent),var(--gb-gold));
      animation:gb-indeterminate 1.15s ease-in-out infinite;
    }
    .gb-loadmore{display:flex;justify-content:center;padding:10px 0 2px}
    .gb-market-home{display:flex;flex-direction:column;gap:20px}
    .gb-state{
      display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;
      max-width:560px;margin:22px auto;padding:34px 30px;border-radius:var(--gb-r-lg);
      border:1px solid var(--gb-line);background:color-mix(in srgb,var(--gb-l2) 72%,transparent);
      box-shadow:var(--gb-shadow-1);
    }
    .gb-state-icon{
      display:grid;place-items:center;width:52px;height:52px;border-radius:16px;margin-bottom:2px;
      background:color-mix(in srgb,var(--gb-accent) 10%,transparent);color:var(--gb-accent);
    }
    .gb-state.is-error .gb-state-icon{background:color-mix(in srgb,var(--gb-error) 12%,transparent);color:var(--gb-error)}
    .gb-state.is-auth .gb-state-icon{background:color-mix(in srgb,var(--gb-gold) 16%,transparent);color:color-mix(in srgb,var(--gb-gold) 72%,var(--gb-t1))}
    .gb-state-title{margin:0;font-size:16px;font-weight:730;letter-spacing:-.01em}
    .gb-state-desc{margin:0;font-size:12px;color:var(--gb-t2);max-width:42ch;line-height:1.55}
    .gb-state-hint{margin:0;font-size:11px;color:var(--gb-t3);max-width:46ch;line-height:1.55}
    .gb-state-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:8px}
    .gb-code{
      margin:2px 0;padding:8px 14px;border-radius:9px;font-size:12px;
      background:var(--gb-l1);border:1px solid var(--gb-line2);
      font-family:ui-monospace,"SF Mono",Menlo,monospace;color:var(--gb-t1);
    }
    .gb-code code{white-space:nowrap}

    /* ---------------------- 设置 ---------------------- */
    .gb-settings{gap:14px;max-width:900px;width:100%;margin:0 auto}
    .gb-panel > .gb-btn{align-self:flex-start}
    .gb-panel{
      padding:18px 20px 20px;border-radius:var(--gb-r-lg);
      border:1px solid var(--gb-line);background:color-mix(in srgb,var(--gb-l2) 68%,transparent);
      box-shadow:var(--gb-shadow-1);display:flex;flex-direction:column;gap:14px;
    }
    .gb-panel-title{margin:0;font-size:14px;font-weight:730;letter-spacing:-.01em}
    .gb-panel-desc{margin:0;font-size:11.5px;color:var(--gb-t2);line-height:1.55}
    .gb-field{display:flex;flex-direction:column;gap:7px}
    .gb-field-label{font-size:11.5px;font-weight:680;color:var(--gb-t1);letter-spacing:.01em}
    .gb-field-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .gb-field-hint{margin:0;font-size:10.5px;color:var(--gb-t3);line-height:1.5}
    .gb-field-value{font-size:11px;color:var(--gb-t3);min-width:38px;text-align:right;font-variant-numeric:tabular-nums}
    .gb-field-inline{flex-direction:row;flex-wrap:wrap;gap:18px}
    .gb-slider-row{gap:10px}
    .gb-input{
      flex:1;min-width:180px;height:34px;padding:0 11px;border-radius:9px;
      border:1px solid var(--gb-line);background:var(--gb-l2);color:var(--gb-t1);
      font:inherit;font-size:12px;outline:none;
      transition:border-color 150ms ease,box-shadow 150ms ease;
    }
    .gb-input:focus{border-color:color-mix(in srgb,var(--gb-accent) 40%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-accent) 10%,transparent)}
    .gb-range{
      -webkit-appearance:none;appearance:none;height:4px;border-radius:999px;flex:1;min-width:120px;
      background:linear-gradient(90deg,var(--gb-accent) 0%,var(--gb-gold) 100%);
      outline:none;cursor:pointer;
    }
    .gb-range::-webkit-slider-thumb{
      -webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;
      background:var(--gb-cream);border:2px solid var(--gb-accent);box-shadow:0 2px 6px rgba(0,0,0,.25);
    }
    .gb-range::-moz-range-thumb{
      width:12px;height:12px;border-radius:50%;background:var(--gb-cream);border:2px solid var(--gb-accent);
    }
    .gb-seg{display:inline-flex;gap:3px;padding:3px;border-radius:999px;background:var(--gb-fill);border:1px solid var(--gb-line2);align-self:flex-start}
    .gb-seg-btn{
      height:27px;padding:0 12px;border-radius:999px;border:0;background:transparent;
      color:var(--gb-t2);font-size:11.5px;font-weight:640;transition:background 150ms ease,color 150ms ease;
    }
    .gb-seg-btn:hover{color:var(--gb-t1)}
    .gb-seg-btn.is-active{background:var(--gb-l2);color:var(--gb-t1);box-shadow:var(--gb-shadow-1)}
    .gb-seg-sm .gb-seg-btn{height:24px;padding:0 9px;font-size:10.5px}
    .gb-switch{display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;padding:0;font-size:12px;color:var(--gb-t1)}
    .gb-switch-track{
      position:relative;display:block;width:36px;height:21px;border-radius:999px;flex:none;
      background:var(--gb-fill2);transition:background 170ms ease;
    }
    .gb-switch-knob{
      position:absolute;top:3px;left:3px;width:15px;height:15px;border-radius:50%;
      background:var(--gb-l2);box-shadow:0 1px 3px rgba(0,0,0,.3);
      transition:transform 170ms ease,background 170ms ease;
    }
    .gb-switch.is-on .gb-switch-track{background:var(--gb-accent)}
    .gb-switch.is-on .gb-switch-knob{transform:translateX(15px);background:#fff8ee}
    .gb-switch-text{font-weight:620}
    .gb-meta-list{display:grid;grid-template-columns:1fr;gap:0;margin:0}
    .gb-meta-row{
      display:flex;align-items:baseline;gap:14px;justify-content:space-between;
      padding:8px 0;border-bottom:1px dashed var(--gb-line2);font-size:11.5px;
    }
    .gb-meta-row:last-child{border-bottom:0;padding-bottom:0}
    .gb-meta-row dt{color:var(--gb-t2);flex:none}
    .gb-meta-row dd{margin:0;color:var(--gb-t1);min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}

    /* ---------------------- Toast ---------------------- */
    .gb-toast{
      position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:60;
      display:flex;align-items:center;gap:8px;max-width:min(520px,calc(100% - 32px));
      padding:9px 15px 9px 12px;border-radius:999px;
      background:color-mix(in srgb,var(--gb-l2) 92%,transparent);color:var(--gb-t1);
      border:1px solid var(--gb-line);box-shadow:0 18px 40px -20px rgba(10,6,10,.55);
      font-size:12px;font-weight:620;animation:gb-toast-in 200ms ease;
      backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    }
    .gb-toast.is-success .gb-ico{color:var(--gb-success)}
    .gb-toast.is-error .gb-ico{color:var(--gb-error)}
    .gb-toast.is-info .gb-ico{color:var(--gb-gold)}

    /* ---------------------- 播放器 ---------------------- */
    .gb-root.is-player{background:#0b0a0e;color:#f3e9dd}
    .gb-player{
      position:relative;flex:1;min-height:0;display:flex;flex-direction:column;gap:9px;
      padding:10px 16px 12px;
      background:
        radial-gradient(900px 420px at 50% -20%,rgba(37,99,235,.16),transparent 62%),
        radial-gradient(720px 360px at 50% 120%,rgba(245,183,49,.07),transparent 66%),
        linear-gradient(180deg,#141018 0%,#0a090d 62%);
    }
    .gb-player-top{display:flex;align-items:center;gap:10px;flex:none;min-width:0}
    .gb-player-top .gb-btn-ghost{color:#cbbfb2}
    .gb-player-top .gb-btn-ghost:hover{background:rgba(255,255,255,.07);color:#fff}
    .gb-nameplate{
      flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:9px;
    }
    .gb-nameplate-label{
      font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
      color:rgba(255,240,224,.45);white-space:nowrap;
    }
    .gb-nameplate-title{
      font-size:15px;font-weight:740;letter-spacing:-.01em;color:#fdf3e2;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46vw;
    }
    .gb-player-top-right{display:flex;align-items:center;gap:6px;flex:none}
    .gb-player-top-right .gb-chip{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:rgba(255,240,224,.72)}
    .gb-player-top-right .gb-icon-btn{color:rgba(255,240,224,.7)}
    .gb-player-top-right .gb-icon-btn:hover{background:rgba(255,255,255,.08);color:#fff}
    .gb-player-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
    .gb-screen{
      position:relative;flex:none;overflow:hidden;background:#000;border-radius:10px;
      box-shadow:
        0 0 0 9px #1b1720,
        0 0 0 11px #2c2634,
        0 0 0 12px #100d14,
        0 26px 70px -26px rgba(0,0,0,.95),
        inset 0 0 46px rgba(0,0,0,.85);
      image-rendering:pixelated;
    }
    .gb-canvas{
      display:block;width:100%;height:100%;background:#000;
      image-rendering:pixelated;image-rendering:crisp-edges;
    }
    /* 轻量 CRT：几乎不压暗画面，只留很淡的扫描线与边角，避免「糊了一层脏东西」 */
    .gb-crt-overlay{
      position:absolute;inset:0;pointer-events:none;z-index:2;
      background:
        repeating-linear-gradient(0deg,rgba(0,0,0,.11) 0 1px,rgba(0,0,0,0) 1px 4px),
        radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 62%,rgba(0,0,0,.20) 100%);
      mix-blend-mode:normal;
      opacity:.85;
    }
    .gb-crt-overlay::after{
      content:"";position:absolute;inset:0;
      background:linear-gradient(180deg,rgba(255,255,255,.025),transparent 22%,transparent 80%,rgba(0,0,0,.06));
    }
    .gb-screen-veil{
      position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
      padding:16px;text-align:center;border:0;
      background:rgba(7,5,9,.8);color:#f4e9dc;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);
    }
    .gb-screen-veil.is-paused{cursor:pointer}
    .gb-screen-veil.is-error{color:#ffc9c4}
    .gb-screen-veil .gb-veil-title{font-size:15px;font-weight:720;letter-spacing:.01em}
    .gb-screen-veil .gb-veil-sub{font-size:11px;color:rgba(255,240,224,.62);max-width:36ch;line-height:1.5}
    .gb-veil-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px}
    .gb-start-overlay{
      position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
      border:0;padding:14px;text-align:center;cursor:pointer;color:#fdf3e2;
      background:
        repeating-linear-gradient(0deg,rgba(255,255,255,.03) 0 1px,rgba(255,255,255,0) 1px 3px),
        radial-gradient(ellipse at center,rgba(28,18,26,.9),rgba(6,5,8,.95));
    }
    .gb-start-pad{display:block;filter:drop-shadow(0 16px 26px rgba(0,0,0,.6));margin-bottom:2px;animation:gb-float 3.4s ease-in-out infinite}
    .gb-start-title{font-size:clamp(15px,2.2vw,20px);font-weight:780;letter-spacing:.02em}
    .gb-start-hint{font-size:11px;color:rgba(255,240,224,.62)}
    .gb-start-blink{
      margin-top:4px;font-family:ui-monospace,"SF Mono",Menlo,monospace;
      font-size:11px;font-weight:700;letter-spacing:.22em;color:var(--gb-gold);
      animation:gb-blink 1.25s steps(1,end) infinite;
    }
    .gb-fps{
      position:absolute;top:7px;right:8px;z-index:6;
      font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:9.5px;font-weight:700;
      color:var(--gb-gold);background:rgba(0,0,0,.42);border-radius:4px;padding:1px 5px;
      pointer-events:none;letter-spacing:.02em;
    }
    .gb-fps-bar{position:static;background:transparent;font-size:10px;color:rgba(255,240,224,.55)}
    .gb-player-bar{
      flex:none;display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;
      padding:5px 9px;border-radius:14px;
      background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);
      color:#d9cec2;
    }
    .gb-player-bar .gb-icon-btn{color:rgba(255,240,224,.72);width:30px;height:30px}
    .gb-player-bar .gb-icon-btn:hover{background:rgba(255,255,255,.09);color:#fff}
    .gb-player-bar .gb-icon-btn.is-on{color:var(--gb-gold)}
    .gb-player-bar .gb-btn{background:transparent;border-color:transparent;color:rgba(255,240,224,.7)}
    .gb-player-bar .gb-btn:hover{background:rgba(255,255,255,.08);color:#fff}
    .gb-play-btn{
      width:38px!important;height:38px!important;border-radius:50%!important;
      background:linear-gradient(140deg,var(--gb-accent),#8f0a20)!important;color:#fff8ee!important;
      box-shadow:0 10px 22px -12px rgba(37,99,235,.9);
    }
    .gb-play-btn:hover{filter:brightness(1.1)}
    .gb-bar-sep{width:1px;height:18px;background:rgba(255,255,255,.1);margin:0 4px;flex:none}
    .gb-bar-volume{display:flex;align-items:center;gap:5px;min-width:0}
    .gb-range-player{width:78px;min-width:60px;height:3px;flex:none}
    .gb-player-bar .gb-seg{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.08)}
    .gb-player-bar .gb-seg-btn{color:rgba(255,240,224,.6)}
    .gb-player-bar .gb-seg-btn.is-active{background:rgba(255,255,255,.14);color:#fff;box-shadow:none}
    .gb-bar-spacer{flex:1 1 0;min-width:0}

    /* 存档面板 */
    .gb-saves{
      position:absolute;right:18px;bottom:88px;z-index:30;width:420px;max-width:calc(100% - 36px);
      padding:12px;border-radius:16px;
      background:rgba(22,18,26,.97);border:1px solid rgba(255,255,255,.12);
      box-shadow:0 30px 70px -24px rgba(0,0,0,.9);color:#f4e9dc;
      animation:gb-pop 160ms ease;
    }
    .gb-saves-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 8px}
    .gb-saves-head h3{margin:0;font-size:13px;font-weight:730;letter-spacing:.01em}
    .gb-saves-head .gb-icon-btn{color:rgba(255,240,224,.65)}
    .gb-saves-head .gb-icon-btn:hover{background:rgba(255,255,255,.08);color:#fff}
    .gb-save-row{
      display:flex;align-items:center;gap:9px;padding:7px;border-radius:10px;
      transition:background 140ms ease;
    }
    .gb-save-row:hover{background:rgba(255,255,255,.045)}
    .gb-save-row.is-empty{opacity:.72}
    .gb-save-thumb{
      display:grid;place-items:center;flex:none;width:62px;height:47px;border-radius:6px;overflow:hidden;
      background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:rgba(255,240,224,.45);
    }
    .gb-save-thumb img{width:100%;height:100%;object-fit:cover;image-rendering:pixelated}
    .gb-save-info{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
    .gb-save-name{font-size:11.5px;font-weight:680}
    .gb-save-meta{font-size:10px;color:rgba(255,240,224,.52);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gb-saves .gb-btn{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.1);color:#f4e9dc}
    .gb-saves .gb-btn:hover{background:rgba(255,255,255,.13)}
    .gb-saves .gb-btn-accent{background:linear-gradient(135deg,var(--gb-accent),#8f0a20);border-color:transparent;color:#fff8ee}
    .gb-saves .gb-btn.is-danger{color:#ff9b93}
    .gb-saves-note{margin:6px 4px 0;font-size:10px;color:rgba(255,240,224,.42);line-height:1.5}

    /* 按键提示 */
    .gb-keyhints{
      flex:none;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;
      padding:4px 10px 0;color:rgba(255,240,224,.6);font-size:10.5px;
    }
    .gb-keyhint{display:inline-flex;align-items:center;gap:5px}
    .gb-keyhint-label{white-space:nowrap}
    .gb-keyhint-keys{display:inline-flex;gap:2px}
    .gb-keyhint kbd{
      display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;
      border-radius:4px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.14);
      border-bottom-width:2px;color:#f4e9dc;font-family:ui-monospace,"SF Mono",Menlo,monospace;
      font-size:9.5px;font-weight:700;line-height:1;
    }

    /* 触屏虚拟键 */
    .gb-touch{
      flex:none;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;
      gap:10px;padding:2px 6px 0;pointer-events:none;
    }
    .gb-touch-dpad{display:grid;grid-template-columns:repeat(3,40px);grid-template-rows:repeat(3,40px);gap:2px;justify-self:start;pointer-events:none}
    .gb-touch-face{display:flex;align-items:center;gap:12px;justify-self:end;pointer-events:none}
    .gb-touch-mid{display:flex;gap:8px;align-items:center;justify-self:center;pointer-events:none}
    .gb-touch-btn{
      pointer-events:auto;display:grid;place-items:center;border-radius:10px;
      border:1px solid rgba(255,255,255,.16);
      background:rgba(18,14,22,.62);color:rgba(255,248,238,.9);
      font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;font-weight:800;
      backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
      touch-action:none;user-select:none;-webkit-user-select:none;box-shadow:0 8px 18px -12px rgba(0,0,0,.8);
    }
    .gb-touch-btn:active{background:rgba(37,99,235,.62);transform:scale(.94)}
    .gb-touch-btn.up{grid-area:1/2}
    .gb-touch-btn.left{grid-area:2/1}
    .gb-touch-btn.right{grid-area:2/3}
    .gb-touch-btn.down{grid-area:3/2}
    .gb-touch-btn.pill{min-width:62px;height:26px;border-radius:999px;font-size:9px;letter-spacing:.08em}
    .gb-touch-btn.face{width:52px;height:52px;border-radius:50%;font-size:17px}
    .gb-touch-btn.face.b{background:rgba(245,183,49,.24);border-color:rgba(245,183,49,.5);color:#ffe0a0}
    .gb-touch-btn.face.a{background:rgba(37,99,235,.3);border-color:rgba(96,165,250,.55);color:#ffd2d4}

    .gb-player-top,.gb-player-bar,.gb-keyhints{transition:opacity 220ms ease}
    .gb-player.is-controls-hidden{cursor:none}
    .gb-player.is-controls-hidden .gb-player-top,
    .gb-player.is-controls-hidden .gb-player-bar,
    .gb-player.is-controls-hidden .gb-keyhints{opacity:0;pointer-events:none}
    /* 全屏：stage 占满 viewport，顶部/控制条浮在画面上（自动隐藏后才是真正的满屏） */
    .gb-player:fullscreen{background:#050508;padding:0;gap:0}
    .gb-player:fullscreen .gb-player-stage{flex:1;min-height:0;padding:0}
    .gb-player:fullscreen .gb-screen{border-radius:0;box-shadow:none}
    .gb-player:fullscreen .gb-player-top{
      position:absolute;top:0;left:0;right:0;z-index:20;padding:10px 16px;
      background:linear-gradient(180deg,rgba(0,0,0,.6),rgba(0,0,0,0));
    }
    .gb-player:fullscreen .gb-player-bar{
      position:absolute;left:0;right:0;bottom:0;z-index:20;margin:0;border-radius:0;
      border-left:0;border-right:0;padding:7px 10px;
      background:rgba(10,8,12,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    }
    .gb-player:fullscreen .gb-keyhints{
      position:absolute;left:0;right:0;bottom:52px;z-index:19;padding:0 10px 6px;
      background:linear-gradient(0deg,rgba(0,0,0,.5),rgba(0,0,0,0));
    }
    .gb-player:fullscreen .gb-saves{bottom:96px;right:20px}

    /* 侧栏入口图标 */
    .gb-panel-mark{
      display:grid;place-items:center;flex:none;box-sizing:border-box;overflow:hidden;
      transition:background 160ms ease;
    }

    /* ---------------------- 动画 ---------------------- */
    @keyframes gb-spin{to{transform:rotate(360deg)}}
    @keyframes gb-fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    @keyframes gb-pop{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
    @keyframes gb-toast-in{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
    @keyframes gb-shimmer{0%,100%{background-position:130% 0}50%{background-position:-30% 0}}
    @keyframes gb-indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
    @keyframes gb-blink{0%,55%{opacity:1}56%,100%{opacity:.25}}
    @keyframes gb-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}

    /* ---------------------- 响应式 ---------------------- */
    @media (max-width:1180px){
      .gb-head{padding-left:22px;padding-right:22px}
      .gb-tabs{padding-left:22px;padding-right:22px}
      .gb-wrap{padding-left:22px;padding-right:22px}
    }
    @media (max-width:860px){
      .gb-head{padding:12px 16px 8px;gap:10px}
      .gb-tabs{padding:2px 16px 6px}
      .gb-wrap{padding:6px 16px 26px}
      .gb-brand-title{font-size:18px}
      .gb-brand-mark{width:40px;height:40px;border-radius:13px}
      .gb-hero{padding:20px 22px;min-height:170px}
      .gb-hero-title{font-size:23px}
      .gb-hero-art{display:none}
      .gb-grid{grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:14px 12px}
      .gb-market-grid{grid-template-columns:repeat(auto-fill,minmax(118px,1fr))}
      .gb-rail .gb-market-card{width:124px}
      .gb-saves{right:10px;left:10px;width:auto;bottom:96px}
      .gb-player{padding:8px 10px 10px}
      .gb-nameplate-label{display:none}
      .gb-nameplate-title{max-width:52vw;font-size:13px}
      .gb-player-top .gb-btn-ghost span{display:none}
      .gb-bar-volume{display:none}
      .gb-player-bar .gb-btn-ghost{display:none}
      .gb-touch{gap:8px;padding:0 2px}
      .gb-touch-dpad{grid-template-columns:repeat(3,36px);grid-template-rows:repeat(3,36px)}
      .gb-touch-btn.face{width:46px;height:46px}
      .gb-touch-btn.pill{min-width:52px;height:24px}
    }
    @media (max-width:560px){
      .gb-head-right .gb-chip{display:none}
      .gb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .gb-market-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .gb-hero{padding:16px 18px}
      .gb-hero-actions{flex-wrap:wrap}
      .gb-state{padding:26px 18px;margin:14px auto}
      .gb-panel{padding:14px 15px 16px}
      .gb-field-row .gb-btn{padding:0 10px}
      .gb-player-bar{gap:2px;padding:4px 6px}
      .gb-player-bar .gb-range-player{width:54px}
      .gb-keyhints{gap:9px;font-size:9.5px}
      .gb-keyhint kbd{min-width:15px;height:15px;font-size:9px}
      .gb-saves{bottom:92px}
      .gb-touch-mid{flex-direction:column;gap:5px}
      .gb-touch-btn.pill{min-width:44px}
    }
    @media (prefers-reduced-motion:reduce){
      .gb-root *,.gb-root *::before,.gb-root *::after{
        animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;
      }
      .gb-start-blink{opacity:1}
    }
    @media (pointer:coarse){
      .gb-card-play{opacity:1;transform:none}
      .gb-card-menu-btn{opacity:1}
    }
    `

    /* 文案字典（中文兜底；英文完整覆盖） */
    const ZH = {
      'meta.title': '拾光游戏厅',
      'meta.subtitle': '童年经典 · 打开即玩',
      'settings.title': '拾光游戏厅设置',
      'meta.badgeBuiltin': '内置 {n}',
      'meta.badgeInstalled': '已装 {n}',
      'tab.library': '游戏库',
      'tab.market': '游戏市场',

      'action.save': '保存',
      'action.clear': '清除',
      'action.load': '读取',
      'action.loadMore': '加载更多',
      'action.loading': '加载中…',
      'action.retry': '重试',
      'action.install': '下载',
      'action.installing': '下载中',
      'action.play': '开始游戏',
      'action.playGame': '开始玩「{title}」',
      'action.pause': '暂停',
      'action.resumePlay': '继续',
      'action.reset': '重置',
      'action.more': '更多',
      'action.delete': '删除',
      'action.deleting': '删除中',
      'action.cancel': '取消',
      'action.overwrite': '覆盖',
      'action.back': '返回',
      'action.backToLibrary': '返回游戏库',
      'action.close': '关闭',

      'language.zh': '简',
      'language.trad': '繁',

      'library.builtin': '内置',
      'library.downloaded': '已下载',
      'library.lastPlayed': '上次玩于 {time}',
      'library.neverPlayed': '还没开过机',
      'library.section.all': '全部游戏',
      'library.section.count': '共 {n} 款',
      'library.footnote': '内置游戏随插件分发，断网也能玩；市场游戏下载一次后同样离线可玩。',
      'library.empty.title': '游戏库是空的',
      'library.empty.desc': '内置卡带没有加载出来。如果是刚装好插件，重试一次就好。',
      'library.empty.action': '去游戏市场看看',
      'library.error.title': '游戏库读不出来',
      'library.error.hint': '插件 Host 可能还没就绪，稍后再试一次。',
      'library.deleteAsk': '从本机删除「{title}」？',
      'library.deleteNote': '存档会保留。想再玩时可以在市场重新下载。',
      'library.hero.eyebrow': '继续上次',
      'library.hero.continue': '接着玩',
      'library.hero.restart': '重新开始',
      'library.hero.lastPlayed': '上次游玩 {time}',
      'library.hero.playedFor': '共玩了 {time}',
      'library.welcome.eyebrow': '打开即玩',
      'library.welcome.title': '插上卡带，挑一款开打',
      'library.welcome.desc': '内置游戏已经装好，点开卡片即刻开玩',
      'library.welcome.playFirst': '玩第一款',
      'library.welcome.browseMarket': '逛逛游戏市场',

      'market.all': '全部',
      'market.allGames': '全部游戏',
      'market.collections': '合集',
      'market.featured': '本周精选',
      'market.featuredHint': '编辑部挑出来的 12 款',
      'market.searchPlaceholder': '搜索游戏、系列或中文版',
      'market.installed': '已安装',
      'market.playInstalled': '已安装 · 开玩',
      'market.nes': 'NES 卡带',
      'market.resultsFor': '「{q}」的搜索结果',
      'market.totalCount': '{n} 款',
      'market.empty.title': '没找到「{q}」',
      'market.empty.desc': '换个关键词，或者清空搜索浏览全部游戏。',
      'market.empty.collectionTitle': '这个合集暂时没有可玩的',
      'market.empty.collectionDesc': '换一个合集看看，说不定有惊喜。',
      'market.empty.reset': '浏览全部',
      'market.auth.title': '市场需要 GitHub 权限',
      'market.auth.short': '没有 GitHub 访问权限',
      'market.auth.desc': '游戏目录放在 GitHub 上的私有资源库，第一次打开市场要先获得访问权限。',
      'market.auth.hint': '任选一种：在终端执行 gh auth login 登录后点「重试」；或者到设置里粘贴一个 Personal Access Token。',
      'market.auth.goSettings': '去设置粘贴 Token',
      'market.auth.retry': '已登录，重试',
      'market.auth.footnote': '内置游戏不受影响，随时都能玩。',
      'market.error.title': '连不上 GitHub',
      'market.error.hint': '内置游戏不受影响，随时都能玩。',
      'market.syncNow': '同步目录',
      'market.synced': '目录已更新，共 {n} 款',
      'market.syncFailed': '同步失败：{error}',
      'market.installSuccess': '已装好「{title}」',
      'market.uninstallSuccess': '已删除「{title}」',
      'market.footnote': '资源库版本 {version} · 数据来自 GitHub',

      'player.nowPlaying': '正在游玩',
      'player.bootTitle': '正在插卡…',
      'player.bootHint': '装载模拟器与 ROM',
      'player.startOverlay': '点击开始',
      'player.startHint': '点任意处解锁声音，马上开打',
      'player.pressStart': 'PRESS START',
      'player.paused': '已暂停',
      'player.pausedHint': '点这里继续，Esc 返回游戏库',
      'player.mediaPaused': '检测到其它播放器在响，游戏先暂停了',
      'player.audioBlockedShort': '声音被浏览器拦住了，点一下画面',
      'player.gamepad': '手柄已连接',
      'player.fullscreen': '全屏',
      'player.exitFullscreen': '退出全屏',
      'player.crt': 'CRT 滤镜',
      'player.speed': '倍速',
      'player.screenMode': '画面比例',
      'player.screenModeTitle': '画面比例：{mode}',
      'player.screenModeChanged': '画面比例：{mode}',
      'player.screen.fit': '4:3 比例',
      'player.screen.stretch': '铺满',
      'player.screen.pixel': '像素',
      'player.volume': '音量',
      'player.mute': '静音',
      'player.unmute': '取消静音',
      'player.screenshot': '截图',
      'player.screenshotSaved': '截图已保存',
      'player.screenshotFailed': '截图失败，再试一次',
      'player.keys': '按键提示',
      'player.keys.move': '移动',
      'player.keys.a': 'A 键',
      'player.keys.b': 'B 键',
      'player.keys.start': 'Start',
      'player.keys.select': 'Select',
      'player.keys.escape': '返回游戏库',
      'player.resetDone': '已重置',
      'player.errorTitle': '这一款没跑起来',
      'player.save.title': '存档',
      'player.save.loadTitle': '读档',
      'player.save.auto': '自动存档',
      'player.save.slot': '存档位 {n}',
      'player.save.empty': '空档位',
      'player.save.emptySlot': '这个档位还是空的',
      'player.save.saved': '已存入{slot}',
      'player.save.loaded': '已读取{slot}',
      'player.save.failed': '存档失败：{error}',
      'player.save.loadFailed': '读档失败：{error}',
      'player.save.autoSaved': '已自动存档',
      'player.save.recordMeta': '{time} · 玩了 {duration}',
      'player.save.confirmOverwrite': '确认覆盖',
      'player.save.note': '自动存档每 60 秒写一次；退出播放器时也会存一档。',
      'player.save.loadNote': '读档会回到存档时的关卡与状态。',

      'auth.settings': '设置里的 Token',
      'auth.env': '环境变量',
      'auth.gh': '本机 gh 登录',
      'auth.public': '公开仓库',
      'auth.none': '未配置',
      'state.ready': '就绪',
      'state.degraded': '未就绪',

      'settings.section.access': 'GitHub 访问',
      'settings.section.accessDesc': '市场目录放在 GitHub 私有仓库里，填一个只读的 Token 最省事。',
      'settings.token': '访问 Token',
      'settings.tokenKeep': '已保存，留空表示不修改',
      'settings.tokenHint': '只保存在本机（0600 权限），不会回显；清空后立刻失效。',
      'settings.repo': '资源库仓库',
      'settings.repoHint': '形如 owner/name，默认 zeelinkCN/game-bench-library。',
      'settings.repoInvalid': '仓库名要写成 owner/name',
      'settings.section.play': '游玩偏好',
      'settings.volume': '默认音量',
      'settings.keys': '按键方案',
      'settings.keys.default': '默认 Z=B / X=A',
      'settings.keys.arcade': '街机 Z=A / X=B',
      'settings.keysHint': '方向键、Enter、Shift 不变；只交换 A/B。',
      'settings.crt': 'CRT 滤镜',
      'settings.fps': '显示帧率',
      'settings.screen': '画面比例',
      'settings.screenHint': '默认 4:3 接近当年的电视；「铺满」会拉伸画面，「像素」保持整数倍清晰。CRT 滤镜是另一项，可单独开关。',
      'settings.section.data': '数据与状态',
      'settings.dataDir': '数据目录',
      'settings.auth': '市场鉴权',
      'settings.marketState': '目录状态',
      'settings.catalogGames': '目录游戏',
      'settings.lastSync': '上次同步',
      'settings.version': '版本',
      'settings.section.maintenance': '维护',
      'settings.syncDesc': '目录缓存 24 小时刷新一次。看不到新上架的游戏时，可以手动同步。',
      'settings.sync': '强制同步目录',
      'settings.syncing': '正在同步…',
      'settings.saved': '设置已保存',
      'settings.failed': '保存失败：{error}',
      'settings.never': '从未同步',
      'settings.footnote': '拾光游戏厅 v{version} · 内置经典红白机游戏',

      'toast.error': '出错了：{error}',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'time.never': '还没玩过',
      'duration.seconds': '{n} 秒',
      'duration.minutes': '{n} 分钟',
      'duration.hours': '{n} 小时 {m} 分',
      'error.network': '网络不太稳定，稍后再试',
      'error.unknown': '出现意外错误',
      'error.runtimeMissing': '模拟器运行时还没有就绪',
      'error.badRom': '这一款 ROM 读不出来',
      'error.romMissing': '找不到这一款 ROM，可能已被移除',
    }

    const EN = {
      'meta.title': 'Game Bench',
      'meta.subtitle': 'Childhood classics · ready to play',
      'settings.title': 'Game Bench settings',
      'meta.badgeBuiltin': 'Built-in {n}',
      'meta.badgeInstalled': 'Installed {n}',
      'tab.library': 'Library',
      'tab.market': 'Market',

      'action.save': 'Save',
      'action.clear': 'Clear',
      'action.load': 'Load',
      'action.loadMore': 'Load more',
      'action.loading': 'Loading…',
      'action.retry': 'Retry',
      'action.install': 'Install',
      'action.installing': 'Installing',
      'action.play': 'Play',
      'action.playGame': 'Play “{title}”',
      'action.pause': 'Pause',
      'action.resumePlay': 'Resume',
      'action.reset': 'Reset',
      'action.more': 'More',
      'action.delete': 'Delete',
      'action.deleting': 'Deleting',
      'action.cancel': 'Cancel',
      'action.overwrite': 'Overwrite',
      'action.back': 'Back',
      'action.backToLibrary': 'Back to library',
      'action.close': 'Close',

      'language.zh': 'ZH',
      'language.trad': 'TW',

      'library.builtin': 'Built-in',
      'library.downloaded': 'Downloaded',
      'library.lastPlayed': 'Last played {time}',
      'library.neverPlayed': 'Not played yet',
      'library.section.all': 'All games',
      'library.section.count': '{n} games',
      'library.footnote': 'Built-in games ship with the plugin and work offline; downloaded games also play offline.',
      'library.empty.title': 'Your library is empty',
      'library.empty.desc': 'The built-in cartridges did not load. If you just installed the plugin, try again.',
      'library.empty.action': 'Browse the market',
      'library.error.title': 'Could not read the library',
      'library.error.hint': 'The plugin host may still be starting. Try again in a moment.',
      'library.deleteAsk': 'Remove “{title}” from this device?',
      'library.deleteNote': 'Saves are kept. You can download it again from the market.',
      'library.hero.eyebrow': 'Continue',
      'library.hero.continue': 'Continue',
      'library.hero.restart': 'Restart',
      'library.hero.lastPlayed': 'Last played {time}',
      'library.hero.playedFor': 'Played {time}',
      'library.welcome.eyebrow': 'Plug and play',
      'library.welcome.title': 'Pick a cartridge and go',
      'library.welcome.desc': 'The built-in games are ready. Tap a card to start.',
      'library.welcome.playFirst': 'Play the first one',
      'library.welcome.browseMarket': 'Browse the market',

      'market.all': 'All',
      'market.allGames': 'All games',
      'market.collections': 'Collections',
      'market.featured': 'Featured this week',
      'market.featuredHint': 'Twelve picks from the editors',
      'market.searchPlaceholder': 'Search games, series, Chinese versions',
      'market.installed': 'Installed',
      'market.playInstalled': 'Installed · Play',
      'market.nes': 'NES cartridge',
      'market.resultsFor': 'Results for “{q}”',
      'market.totalCount': '{n} games',
      'market.empty.title': 'No match for “{q}”',
      'market.empty.desc': 'Try another keyword, or clear the search to browse everything.',
      'market.empty.collectionTitle': 'Nothing playable in this collection yet',
      'market.empty.collectionDesc': 'Try another collection.',
      'market.empty.reset': 'Browse all',
      'market.auth.title': 'GitHub access required',
      'market.auth.short': 'No GitHub access',
      'market.auth.desc': 'The catalog lives in a private GitHub repository. Grant access once to open the market.',
      'market.auth.hint': 'Either run gh auth login in a terminal and hit Retry, or paste a Personal Access Token in Settings.',
      'market.auth.goSettings': 'Paste a token in Settings',
      'market.auth.retry': 'Signed in, retry',
      'market.auth.footnote': 'Built-in games are not affected and always work.',
      'market.error.title': 'Cannot reach GitHub',
      'market.error.hint': 'Built-in games are not affected and always work.',
      'market.syncNow': 'Sync catalog',
      'market.synced': 'Catalog updated, {n} games',
      'market.syncFailed': 'Sync failed: {error}',
      'market.installSuccess': 'Installed “{title}”',
      'market.uninstallSuccess': 'Removed “{title}”',
      'market.footnote': 'Catalog {version} · data from GitHub',

      'player.nowPlaying': 'Now playing',
      'player.bootTitle': 'Inserting cartridge…',
      'player.bootHint': 'Loading emulator and ROM',
      'player.startOverlay': 'Click to start',
      'player.startHint': 'Tap anywhere to unlock audio and play',
      'player.pressStart': 'PRESS START',
      'player.paused': 'Paused',
      'player.pausedHint': 'Click here to resume, Esc to leave',
      'player.mediaPaused': 'Another player started, so the game paused',
      'player.audioBlockedShort': 'Audio blocked by the browser, click the screen',
      'player.gamepad': 'Gamepad connected',
      'player.fullscreen': 'Fullscreen',
      'player.exitFullscreen': 'Exit fullscreen',
      'player.crt': 'CRT filter',
      'player.speed': 'Speed',
      'player.screenMode': 'Screen mode',
      'player.screenModeTitle': 'Screen mode: {mode}',
      'player.screenModeChanged': 'Screen mode: {mode}',
      'player.screen.fit': '4:3',
      'player.screen.stretch': 'Fill',
      'player.screen.pixel': 'Pixel',
      'player.volume': 'Volume',
      'player.mute': 'Mute',
      'player.unmute': 'Unmute',
      'player.screenshot': 'Screenshot',
      'player.screenshotSaved': 'Screenshot saved',
      'player.screenshotFailed': 'Screenshot failed, try again',
      'player.keys': 'Controls',
      'player.keys.move': 'Move',
      'player.keys.a': 'A',
      'player.keys.b': 'B',
      'player.keys.start': 'Start',
      'player.keys.select': 'Select',
      'player.keys.escape': 'Back to library',
      'player.resetDone': 'Reset',
      'player.errorTitle': 'This one did not start',
      'player.save.title': 'Save',
      'player.save.loadTitle': 'Load',
      'player.save.auto': 'Auto save',
      'player.save.slot': 'Slot {n}',
      'player.save.empty': 'Empty slot',
      'player.save.emptySlot': 'This slot is empty',
      'player.save.saved': 'Saved to {slot}',
      'player.save.loaded': 'Loaded {slot}',
      'player.save.failed': 'Save failed: {error}',
      'player.save.loadFailed': 'Load failed: {error}',
      'player.save.autoSaved': 'Auto saved',
      'player.save.recordMeta': '{time} · played {duration}',
      'player.save.confirmOverwrite': 'Overwrite?',
      'player.save.note': 'Auto save every 60 seconds, and once more when you leave.',
      'player.save.loadNote': 'Loading returns to the exact stage and state.',

      'auth.settings': 'Token from settings',
      'auth.env': 'Environment variable',
      'auth.gh': 'Local gh login',
      'auth.public': 'Public repository',
      'auth.none': 'Not configured',
      'state.ready': 'Ready',
      'state.degraded': 'Not ready',

      'settings.section.access': 'GitHub access',
      'settings.section.accessDesc': 'The catalog lives in a private GitHub repository. A read-only token is the simplest option.',
      'settings.token': 'Access token',
      'settings.tokenKeep': 'Saved; leave blank to keep it',
      'settings.tokenHint': 'Stored only on this device (mode 0600) and never echoed. Clearing it revokes access.',
      'settings.repo': 'Library repository',
      'settings.repoHint': 'Format owner/name, default zeelinkCN/game-bench-library.',
      'settings.repoInvalid': 'Repository must be owner/name',
      'settings.section.play': 'Playback',
      'settings.volume': 'Default volume',
      'settings.keys': 'Button layout',
      'settings.keys.default': 'Default · Z=B / X=A',
      'settings.keys.arcade': 'Arcade · Z=A / X=B',
      'settings.keysHint': 'Arrows, Enter and Shift stay the same; only A/B swap.',
      'settings.crt': 'CRT filter',
      'settings.fps': 'Show FPS',
      'settings.screen': 'Screen mode',
      'settings.screenHint': '4:3 matches the old TV look; Fill stretches to the window; Pixel keeps crisp integer scaling. The CRT filter is a separate toggle.',
      'settings.section.data': 'Data and status',
      'settings.dataDir': 'Data directory',
      'settings.auth': 'Market auth',
      'settings.marketState': 'Catalog status',
      'settings.catalogGames': 'Catalog games',
      'settings.lastSync': 'Last sync',
      'settings.version': 'Version',
      'settings.section.maintenance': 'Maintenance',
      'settings.syncDesc': 'The catalog cache refreshes every 24 hours. Sync manually if a new release is missing.',
      'settings.sync': 'Force sync catalog',
      'settings.syncing': 'Syncing…',
      'settings.saved': 'Settings saved',
      'settings.failed': 'Save failed: {error}',
      'settings.never': 'Never',
      'settings.footnote': 'Game Bench v{version} · classic NES games built in',

      'toast.error': 'Something went wrong: {error}',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} h ago',
      'time.daysAgo': '{n} d ago',
      'time.never': 'never',
      'duration.seconds': '{n}s',
      'duration.minutes': '{n} min',
      'duration.hours': '{n} h {m} min',
      'error.network': 'The network seems unstable, try again later',
      'error.unknown': 'Unexpected error',
      'error.runtimeMissing': 'The emulator runtime is not available yet',
      'error.badRom': 'This ROM could not be read',
      'error.romMissing': 'This ROM is missing, it may have been removed',
    }

    /* ================================================================== *
     * 插件导出：注入 slots / locale / layout
     * ================================================================== */
    let layoutService = null
    let booted = false

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        layoutService = (ctx && ctx.layout) || null
        const effect = (fn, label) => (typeof ctx.effect === 'function' ? ctx.effect(fn, label) : fn())

        /* 1) 样式 */
        effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-gb-style', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            try {
              style.remove()
            } catch {
              /* ignore */
            }
          }
        }, 'game-bench: styles')

        /* 2) 文案注册（中文兜底 + 英文） */
        effect(() => {
          const locale = ctx.locale
          const disposers = []
          if (locale && typeof locale.register === 'function') {
            try {
              const disposeZh = locale.register(NS, 'zh', ZH)
              if (typeof disposeZh === 'function') disposers.push(disposeZh)
            } catch {
              /* ignore */
            }
            try {
              const disposeEn = locale.register(NS, 'en', EN)
              if (typeof disposeEn === 'function') disposers.push(disposeEn)
            } catch {
              /* ignore */
            }
          }
          if (locale && typeof locale.bind === 'function') {
            try {
              const bound = locale.bind(NS)
              translate = (key, params) => {
                let value = null
                try {
                  value = bound(key)
                } catch {
                  value = null
                }
                if (!value || value === key) value = ZH[key] || key
                return interpolate(value, params)
              }
            } catch {
              /* ignore */
            }
          }
          if (locale && typeof locale.subscribe === 'function') {
            try {
              const off = locale.subscribe(() => bumpLocale())
              if (typeof off === 'function') disposers.push(off)
            } catch {
              /* ignore */
            }
          }
          bumpLocale()
          return () => {
            disposers.forEach((dispose) => {
              try {
                dispose()
              } catch {
                /* ignore */
              }
            })
          }
        }, 'game-bench: locale')

        /* 3) 数据启动（状态 + 游戏库 + 本地偏好） */
        effect(() => {
          let stopped = false
          if (!booted) {
            booted = true
            Promise.resolve()
              .then(() => bootstrap())
              .catch(() => {
                if (!stopped) setState({ ready: true, libraryLoading: false })
              })
          }
          return () => {
            stopped = true
          }
        }, 'game-bench: bootstrap')

        /* 4) 媒体仲裁 + 页面隐藏自动暂停 + 全屏状态 */
        effect(() => {
          const teardownMedia = setupMediaArbitration()
          document.addEventListener('visibilitychange', onVisibilityChange)
          document.addEventListener('fullscreenchange', onFullscreenChange)
          return () => {
            try {
              teardownMedia()
            } catch {
              /* ignore */
            }
            document.removeEventListener('visibilitychange', onVisibilityChange)
            document.removeEventListener('fullscreenchange', onFullscreenChange)
            teardownPlayer()
          }
        }, 'game-bench: media + lifecycle')

        /* 5) 整页面板 */
        effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS }, Page)),
          'game-bench: page',
        )

        /* 6) 左侧栏入口 */
        effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: NS,
                  order: 30,
                  label: () => translate('meta.title'),
                },
                PanelIcon,
              ),
            ),
          'game-bench: sidebar entry',
        )

        /* 7) 调试 / 验收句柄 */
        effect(() => {
          try {
            window.__GAME_BENCH__ = {
              getState: getSnapshot,
              setState,
              subscribe: subscribeStore,
              actions: {
                goto,
                playGame,
                exitPlayer,
                bootPlayer,
                teardownPlayer,
                togglePause,
                resumeGame,
                saveToSlot,
                loadFromSlot,
                startAudio,
                installGame,
                uninstallGame,
                loadLibrary,
                loadMarket,
                runCatalog,
                syncMarket,
                loadSettings,
                saveSettings,
              },
              getEngine: () => engine,
              getLayout: () => layoutService,
              screenSizeFor,
              screenModes: SCREEN_MODES.slice(),
              version: localeVersion,
            }
          } catch {
            /* ignore */
          }
          return () => {
            try {
              delete window.__GAME_BENCH__
            } catch {
              /* ignore */
            }
          }
        }, 'game-bench: debug handle')
      },
    }
  },
})
