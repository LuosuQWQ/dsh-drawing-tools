window.__ModuleLoader__.load({
  // 这个 id 必须等于 package.json 的 name：@deepseek-ai/dsh-client-modules 是按
  // "<包名>/client" 取模块、再按同一个 id 认领的，写成旧包名会让整个客户端半不激活
  // （表现为侧边栏入口、错误提示条一起消失，宿主半却照常工作）。
  id: '@luosuqwq/dsh-drawing-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useSyncExternalStore } = React

    const NS = 'dsh-drawing-agent'
    const DEFAULT_ORIGIN = 'http://127.0.0.1:8188'
    const STYLE_TAG_ID = NS + ':style'
    // 路由前缀沿用历史名 dsh-drawing-agent，与包名 dsh-drawing-tools 解耦：
    // 与 Host 的 BASE 必须一致，改名会让前端路由失效。
    const API_PREFIX = '/plugins/dsh-drawing-agent'
    const TOAST_MS = 12000

    /** 中文文案（用户语言，同时是兜底字典）。 */
    const zh = {
      'entry.label': 'AI 绘画',
      'entry.hint': '打开 ComfyUI 画布（桌面版在右栏，网页版新开标签页）',
      'entry.busy': '正在准备 ComfyUI…',
      'indicator.online': 'ComfyUI 运行中',
      'indicator.offline': 'ComfyUI 未运行',
      'indicator.unknown': 'ComfyUI 状态未知',
      'indicator.busy': 'ComfyUI 准备中',
      'stop.label': '停止 ComfyUI',
      'stop.busy': '正在停止…',
      'stop.hint': '停止本机 ComfyUI 服务（释放显存）',
      'stop.failedTitle': '停止失败',
      'toast.failedTitle': '打不开右栏画布',
      'toast.openBrowser': '在浏览器打开',
      'toast.retry': '重试',
      'toast.close': '关闭',
    }

    /** 英文文案。 */
    const en = {
      'entry.label': 'AI drawing',
      'entry.hint': 'Open the ComfyUI canvas in the right sidebar',
      'entry.busy': 'Preparing ComfyUI…',
      'indicator.online': 'ComfyUI is running',
      'indicator.offline': 'ComfyUI is not running',
      'indicator.unknown': 'ComfyUI state unknown',
      'indicator.busy': 'ComfyUI is starting',
      'stop.label': 'Stop ComfyUI',
      'stop.busy': 'Stopping…',
      'stop.hint': 'Stop the local ComfyUI service (frees VRAM)',
      'stop.failedTitle': 'Could not stop ComfyUI',
      'toast.failedTitle': 'Could not open the canvas',
      'toast.openBrowser': 'Open in browser',
      'toast.retry': 'Retry',
      'toast.close': 'Close',
    }

    /** 颜色一律走主题 token，明暗主题自动跟随。 */
    const STYLE = `
.dshda-settings{max-width:720px;color:var(--dsw-alias-label-primary)}
.dshda-settings h2{font-size:18px;margin:0 0 8px}
.dshda-settings h3{font-size:13px;margin:20px 0 6px;color:var(--dsw-alias-label-secondary)}
.dshda-settings-text{margin:0 0 10px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dshda-cred-row{display:flex;align-items:center;gap:12px;padding:6px 0}
.dshda-cred-input{flex:1 1 auto;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;font-size:13px}
.dshda-cred-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}
.dshda-cred-actions{display:flex;gap:8px;padding:10px 0 4px}
.dshda-cred-btn{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s}
.dshda-cred-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshda-cred-btn:disabled{opacity:.55;cursor:default}
.dshda-cred-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-inverse,#fff)}
.dshda-cred-badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshda-cred-badge.ok{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.dshda-cred-notice{margin-top:8px;padding:7px 10px;border-radius:9px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}

.dshda-entry{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;box-sizing:border-box;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;text-align:left;white-space:nowrap;overflow:hidden;cursor:pointer}
.dshda-entry:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshda-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshda-entry[data-busy="true"]{cursor:progress;opacity:.85}
.dshda-entry-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none}
.dshda-entry-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis}
.dshda-entry-rail{padding:0;justify-content:center}
.dshda-entry-rail .dshda-entry-label{display:none}
.dshda-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshda-dot[data-state="checking"],.dshda-dot[data-state="starting"]{background:var(--dsw-alias-state-warn-primary);animation:dshda-pulse 1s ease-in-out infinite}
.dshda-dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary)}
.dshda-dot[data-state="offline"],.dshda-dot[data-state="unknown"]{background:var(--dsw-alias-state-idle-primary);opacity:.55}
.dshda-entry:disabled{cursor:progress;opacity:.7}
@keyframes dshda-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.dshda-toast{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:min(420px,calc(100vw - 40px));display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.28);pointer-events:auto;font-size:13px;line-height:1.5}
.dshda-toast-title{font-weight:600}
.dshda-toast-text{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-all;max-height:120px;overflow:auto;white-space:pre-wrap}
.dshda-toast-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshda-toast-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dshda-toast-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
`

    /** 极简快照 store：组件用 useSyncExternalStore 订阅。 */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        set(patch) {
          let changed = false
          for (const key of Object.keys(patch)) {
            if (snapshot[key] !== patch[key]) {
              changed = true
              break
            }
          }
          if (!changed) return
          snapshot = { ...snapshot, ...patch }
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch {
              /* 单个监听器异常不影响其它订阅者 */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        dispose() {
          listeners.clear()
        },
      }
    }

    function translate(props, key) {
      if (typeof props.t === 'function') {
        const text = props.t(key)
        if (typeof text === 'string' && text.length > 0 && text !== key) return text
      }
      if (typeof props.tFallback === 'function') {
        const text = props.tFallback(key)
        if (typeof text === 'string' && text.length > 0 && text !== key) return text
      }
      return zh[key] || en[key] || key
    }

    function messageOf(error) {
      if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    }

    function normalizeOrigin(value) {
      if (typeof value !== 'string') return ''
      const trimmed = value.trim().replace(/\/+$/, '')
      return trimmed.length > 0 ? trimmed : ''
    }

    /**
     * Host 的 HTTP 地址。桌面版页面挂在 `dsh-app://app/`，相对路径指不到网关；
     * 桌面壳把 Host 的 HTTP origin 放在 `__DSH_TRANSPORT__.streamBaseUrl`。
     */
    function hostBase() {
      const candidates = []
      const transport = typeof window !== 'undefined' ? window.__DSH_TRANSPORT__ : undefined
      if (transport !== undefined && transport !== null && typeof transport.streamBaseUrl === 'string') {
        candidates.push(transport.streamBaseUrl)
      }
      const boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : undefined
      if (boot !== undefined && boot !== null && typeof boot === 'object') {
        for (const key of ['gatewayUrl', 'apiBaseUrl', 'baseUrl', 'origin', 'url']) {
          if (typeof boot[key] === 'string') candidates.push(boot[key])
        }
      }
      if (typeof location !== 'undefined' && typeof location.protocol === 'string' && /^https?:$/.test(location.protocol)) {
        candidates.push(location.origin)
      }
      for (const candidate of candidates) {
        const normalized = normalizeOrigin(candidate)
        if (/^https?:\/\//.test(normalized)) return normalized
      }
      return ''
    }

    async function hostFetch(path, init) {
      const bases = []
      const base = hostBase()
      if (base !== '') bases.push(base)
      bases.push('')
      let lastError = null
      for (const prefix of bases) {
        try {
          const response = await fetch(prefix + API_PREFIX + path, init)
          if (response.ok || response.status === 502) return response
          lastError = new Error('HTTP ' + response.status)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError ?? new Error('Host 不可达')
    }

    /** 把客户端异常带回去，便于在 Host 侧 /report 读到真实原因。 */
    function reportClient(detail) {
      try {
        void hostFetch('/report', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(detail),
        }).catch(() => {})
      } catch {
        /* 上报失败不影响功能 */
      }
    }

    /** 调色盘 + 画笔。 */
    function DrawingGlyph(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
      return h(
        'span',
        { className: 'dshda-entry-icon', 'aria-hidden': 'true' },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { display: 'block' },
          },
          h('path', {
            d: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-3.9-4-7.2-9-7.2Z',
          }),
          h('circle', { cx: 7.6, cy: 9.4, r: 1.05, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 10.8, cy: 6.8, r: 1.05, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 15, cy: 7.6, r: 1.05, fill: 'currentColor', stroke: 'none' }),
        ),
      )
    }

    /** 注册时的 inject props 不一定转发，apply 里把同一份 props 存这里兜底。 */
    let sharedProps = null
    /** 最近一次渲染时的面板/会话快照，用官方 hook 读出来，供失败诊断使用。 */
    let lastContext = 'n/a'

    function summarize(value) {
      if (value === undefined) return 'undefined'
      if (value === null) return 'null'
      if (typeof value !== 'object') return String(value)
      try {
        const text = JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
        return text === undefined ? Object.prototype.toString.call(value) : text.slice(0, 700)
      } catch (error) {
        return Object.prototype.toString.call(value) + ':' + messageOf(error)
      }
    }

    /** 侧边栏底部入口（Settings 上方）。点击不改变主面板，会话保持挂载。 */
    function FooterAction(props) {
      props = { ...(sharedProps || {}), ...props }
      const store = props.store
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const wide = props.wide !== false
      const label = translate(props, 'entry.label')
      const busy = state.entryState === 'checking' || state.entryState === 'starting'
      const title = busy
        ? translate(props, 'entry.busy')
        : state.entryState === 'failed'
          ? translate(props, 'toast.failedTitle')
          : translate(props, 'entry.hint')
      /* 右侧指示器：ComfyUI 是否在运行（轮询状态）。 */
      const serviceState = busy
        ? state.entryState
        : state.online === true
          ? 'online'
          : state.online === false
            ? 'offline'
            : 'unknown'
      const serviceHint =
        serviceState === 'online'
          ? translate(props, 'indicator.online')
          : serviceState === 'offline'
            ? translate(props, 'indicator.offline')
            : serviceState === 'unknown'
              ? translate(props, 'indicator.unknown')
              : translate(props, 'indicator.busy')

      return h(
        'button',
        {
          type: 'button',
          className: 'dshda-entry' + (wide ? '' : ' dshda-entry-rail'),
          title,
          'aria-label': title,
          'data-busy': busy ? 'true' : 'false',
          'aria-busy': busy ? 'true' : 'false',
          onClick: () => void props.openEntry(),
        },
        h(DrawingGlyph, { size: 16 }),
        h('span', { className: 'dshda-entry-label' }, label),
        h('span', {
          className: 'dshda-dot',
          'data-state': serviceState,
          title: serviceHint,
          'aria-label': serviceHint,
          role: 'img',
        }),
      )
    }

    /** 停止服务：只在 ComfyUI 在线时出现（Settings 上方，紧挨着入口）。 */
    function StopAction(props) {
      props = { ...(sharedProps || {}), ...props }
      const store = props.store
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const wide = props.wide !== false
      const stopping = state.stopping === true
      if (!stopping && state.online !== true) return null
      const label = stopping ? translate(props, 'stop.busy') : translate(props, 'stop.label')
      return h(
        'button',
        {
          type: 'button',
          className: 'dshda-entry' + (wide ? '' : ' dshda-entry-rail'),
          title: translate(props, 'stop.hint'),
          'aria-label': translate(props, 'stop.hint'),
          'data-busy': stopping ? 'true' : 'false',
          'aria-busy': stopping ? 'true' : 'false',
          disabled: stopping,
          onClick: () => void props.stopService(),
        },
        h(StopGlyph, null),
        h('span', { className: 'dshda-entry-label' }, label),
      )
    }

    /** 方块停止图标。 */
    function StopGlyph() {
      return h(
        'span',
        { className: 'dshda-entry-icon', 'aria-hidden': 'true' },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { display: 'block' },
          },
          h('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.5 }),
        ),
      )
    }

    /** 失败时的轻量提示条（不遮界面、不切主面板）。 */
    function FailureToast(props) {
      props = { ...(sharedProps || {}), ...props }
      const store = props.store
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      if (state.toast === null) return null
      const t = (key) => translate(props, key)
      return h(
        'div',
        { className: 'dshda-toast', role: 'alert' },
        h('div', { className: 'dshda-toast-title' }, t('toast.failedTitle')),
        h('div', { className: 'dshda-toast-text' }, state.toast),
        h(
          'div',
          { className: 'dshda-toast-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshda-toast-btn',
              'data-primary': 'true',
              onClick: () => void props.openEntry(),
            },
            t('toast.retry'),
          ),
          h(
            'button',
            { type: 'button', className: 'dshda-toast-btn', onClick: () => props.openExternal() },
            t('toast.openBrowser'),
          ),
          h(
            'button',
            { type: 'button', className: 'dshda-toast-btn', onClick: () => props.dismissToast() },
            t('toast.close'),
          ),
        ),
      )
    }

    /** 出错兜底：组件抛错只影响这一格，不拖白整页。 */
    class SlotGuard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-drawing-agent] component crashed:', error, info && info.componentStack)
        reportClient({ where: 'render', message: messageOf(error) })
      }

      render() {
        if (this.state.error !== null) return null
        return this.props.children
      }
    }

    function GuardedFooterAction(props) {
      return h(SlotGuard, null, h(FooterAction, props))
    }

    function GuardedStopAction(props) {
      return h(SlotGuard, null, h(StopAction, props))
    }

    function GuardedFailureToast(props) {
      return h(SlotGuard, null, h(FailureToast, props))
    }

    function apply(ctx) {
      const store = createStore({
        origin: '',
        entryState: 'idle',
        toast: null,
        /** ComfyUI 是否在运行：'unknown' | true | false */
        online: 'unknown',
        stopping: false,
      })
      let disposed = false
      let inFlight = null
      let toastTimer = null

      const locale = ctx.locale
      const t = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : (key) => key

      ctx.effect(() => {
        try {
          return locale.register(NS, { zh, en })
        } catch (error) {
          console.warn('[dsh-drawing-agent] locale dictionary rejected:', error)
          return undefined
        }
      }, 'dsh-drawing-agent: dictionary')

      ctx.effect(() => {
        if (typeof document === 'undefined' || document.head === null) return undefined
        for (const previous of Array.from(document.querySelectorAll('style[data-plugin-css="' + STYLE_TAG_ID + '"]'))) {
          previous.remove()
        }
        const tag = document.createElement('style')
        tag.dataset.plugin = NS
        tag.dataset.pluginCss = STYLE_TAG_ID
        tag.textContent = STYLE
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-drawing-agent: style')


      const clearToast = () => {
        if (toastTimer !== null) {
          window.clearTimeout(toastTimer)
          toastTimer = null
        }
        store.set({ toast: null })
      }

      const showToast = (text) => {
        clearToast()
        store.set({ toast: text })
        toastTimer = window.setTimeout(() => {
          toastTimer = null
          store.set({ toast: null })
        }, TOAST_MS)
      }

      const probeStatus = async () => {
        try {
          const response = await hostFetch('/status', {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) return { online: false, error: 'HTTP ' + response.status }
          const data = await response.json()
          const origin = normalizeOrigin(data && data.origin)
          if (origin !== '') store.set({ origin })
          return {
            online: data !== null && data.online === true,
            error: data !== null ? String(data.error || '') : '',
            logPath: data !== null && typeof data.logPath === 'string' ? data.logPath : '',
          }
        } catch (error) {
          return { online: false, error: messageOf(error) }
        }
      }

      const canvasOrigin = () => {
        const origin = store.getSnapshot().origin
        return typeof origin === 'string' && origin !== '' ? origin : DEFAULT_ORIGIN
      }

      /** 把右栏的 mounted 状态尽量完整地描述出来（诊断用）。 */
      const describeValue = (value) => {
        if (value === undefined) return 'undefined'
        if (value === null) return 'null'
        const type = typeof value
        if (type !== 'object' && type !== 'function') return type + ':' + String(value)
        const tag = Object.prototype.toString.call(value)
        let keys = []
        try {
          keys = Object.getOwnPropertyNames(value).slice(0, 12)
        } catch {
          keys = ['keys-unavailable']
        }
        return type + ':' + tag + ':[' + keys.join('|') + ']'
      }

      /** 右栏控制器的关键状态：mounted.getSnapshot() 与会话 surface 是否已采纳。 */
      const readMounted = () => {
        const out = {}
        try {
          const rightbar = ctx.get('sidebarRight')
          if (rightbar === undefined || rightbar === null) return { service: 'absent' }
          const prototype = Object.getPrototypeOf(rightbar)
          out.methods = prototype === null ? [] : Object.getOwnPropertyNames(prototype).slice(0, 40)
          const mounted = rightbar.mounted
          if (mounted !== null && mounted !== undefined && typeof mounted.getSnapshot === 'function') {
            out.mountedSnapshot = describeValue(mounted.getSnapshot())
          } else {
            out.mounted = describeValue(mounted)
          }
          if (typeof rightbar.screen === 'function') {
            const screen = rightbar.screen()
            out.screen = screen === undefined ? 'undefined' : describeValue(screen)
          }
          if (typeof rightbar.mountedSurface === 'function') {
            out.mountedSurface = describeValue(rightbar.mountedSurface())
          }
          if (typeof rightbar.actionsFor === 'function' && typeof mounted?.getSnapshot === 'function') {
            const id = mounted.getSnapshot()
            out.actionsFor = id === undefined ? 'no-id' : describeValue(rightbar.actionsFor(id))
          }
          return out
        } catch (error) {
          return { error: messageOf(error), partial: out }
        }
      }

      /** 用 DSH 右栏的原生浏览器标签打开 ComfyUI。 */
      const openCanvasTab = () => {
        const url = canvasOrigin()
        const rightbar = ctx.get('sidebarRight')
        if (rightbar === undefined || rightbar === null) {
          return { ok: false, detail: 'ctx.sidebarRight 不存在 ' + JSON.stringify(readMounted()) }
        }
        if (typeof rightbar.openTab !== 'function') {
          return { ok: false, detail: 'ctx.sidebarRight.openTab 不可调用' }
        }
        try {
          rightbar.openTab('browser', { params: { url } })
          return { ok: true, detail: '' }
        } catch (error) {
          const detail = messageOf(error) + ' ' + JSON.stringify(readMounted())
          reportClient({ where: 'openTab', reason: messageOf(error), mounted: readMounted(), url, context: lastContext })
          return { ok: false, detail }
        }
      }

      /** 把主面板切回会话：右栏的会话表面只在会话可见时才挂载。 */
      const ensureConversation = async () => {
        try {
          const layout = ctx.get('layout')
          if (layout !== undefined && typeof layout.selectPanel === 'function') {
            layout.selectPanel('conversation')
          }
        } catch (error) {
          console.warn('[dsh-drawing-agent] selectPanel(conversation) 失败:', messageOf(error))
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }

      /** 当前界面是否有可用的右栏（桌面版有；纯浏览器打开的网页版没有）。 */
      const hasRightbar = () => {
        const rightbar = ctx.get('sidebarRight')
        return rightbar !== undefined && rightbar !== null && typeof rightbar.openTab === 'function'
      }

      /**
       * 右栏不可用或多次尝试失败时的降级：直接开一个新的浏览器标签页。
       * 网页版没有右栏，这是唯一可行的呈现方式；桌面版右栏临时失效时也能用。
       */
      const openFallbackTab = (reason) => {
        if (openExternal()) {
          return { ok: true, mode: 'external', detail: reason, logPath: '' }
        }
        return { ok: false, mode: 'external', detail: reason + '；新标签页被浏览器拦截，请允许弹窗后重试' }
      }

      /** 右栏可能还没展开 / 会话还没回到主区域：每一步都补齐再重试。 */
      const openCanvasWithRetry = async (attempts = 4) => {
        if (!hasRightbar()) return openFallbackTab('当前界面没有右栏，已在新标签页打开画布')
        let last = { ok: false, detail: '未尝试' }
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (disposed) return { ok: false, detail: '已卸载' }
          if (attempt > 0) {
            await ensureConversation()
            try {
              const layout = ctx.get('layout')
              if (layout !== undefined && typeof layout.openRightbar === 'function') layout.openRightbar(true, false)
            } catch {
              /* 展开失败也继续重试 openTab */
            }
            await new Promise((resolve) => setTimeout(resolve, 450))
          }
          last = openCanvasTab()
          if (last.ok) return last
        }
        // 右栏存在但打不开（无会话表面、iframe 失败等）：退到新标签页。
        return openFallbackTab('右栏打不开（' + last.detail + '），已在新标签页打开画布')
      }

      const requestStart = async () => {
        try {
          const response = await hostFetch('/start', {
            method: 'POST',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          const body = await response.text().catch(() => '')
          let parsed = null
          try {
            parsed = body ? JSON.parse(body) : null
          } catch {
            /* 非 JSON 响应按纯文本处理 */
          }
          const logPath = parsed !== null && typeof parsed.logPath === 'string' ? parsed.logPath : ''
          if (response.ok) return { ok: true, error: '', logPath }
          reportClient({ where: 'start', status: response.status, body: body.slice(0, 800) })
          const message = parsed !== null && typeof parsed.error === 'string' && parsed.error ? parsed.error : body.slice(0, 400)
          return { ok: false, error: message, logPath }
        } catch (error) {
          return { ok: false, error: messageOf(error), logPath: '' }
        }
      }

      /** 日志位置由 Host 提供（launch.logDir）；拿不到就退中性文案。 */
      const logHint = logPath => '\n日志：' + (logPath || '见插件设置里的 logDir')

      const openExternal = () => {
        try {
          return window.open(canvasOrigin(), '_blank', 'noopener,noreferrer') !== null
        } catch {
          return false
        }
      }

      const runOpenEntry = async () => {
        try {
          const first = await probeStatus()
          let online = first.online
          let logPath = first.logPath
          store.set({ online: online === true })
          if (disposed) return { ok: false, detail: '已卸载' }
          if (!online) {
            store.set({ entryState: 'starting' })
            const started = await requestStart()
            if (started.logPath) logPath = started.logPath
            const second = await probeStatus()
            online = second.online
            if (second.logPath) logPath = second.logPath
            store.set({ online: online === true })
            if (!online && !started.ok) {
              const detail = '启动失败：' + (started.error || second.error || '未知') + logHint(logPath)
              reportClient({ where: 'start-and-probe', detail, context: lastContext })
              store.set({ entryState: 'failed' })
              showToast(detail)
              return { ok: false, detail }
            }
          }
          if (!online) {
            const detail = 'ComfyUI 没就绪：' + (first.error || '') + logHint(logPath)
            store.set({ entryState: 'failed' })
            showToast(detail)
            return { ok: false, detail }
          }
          store.set({ entryState: 'online', online: true })
          /* 先直接试一次：如果右栏本来正常，别去动主面板选择。失败后重试才补齐前置条件。 */
          const result = await openCanvasWithRetry()
          if (!result.ok) {
            store.set({ entryState: 'failed' })

            const detail = result.detail + logHint(logPath)
            reportClient({ where: 'open-canvas', detail, context: lastContext })
            showToast(detail)
            return result
          }
          store.set({ entryState: 'idle' })
          return result
        } catch (error) {
          const detail = messageOf(error)
          store.set({ entryState: 'failed' })
          reportClient({ where: 'openEntry', detail, context: lastContext })
          showToast(detail)
          return { ok: false, detail }
        }
      }

      const openEntry = () => {
        if (disposed) return Promise.resolve({ ok: false, detail: '已卸载' })
        if (inFlight !== null) return inFlight
        store.set({ entryState: 'checking' })
        inFlight = runOpenEntry()
        return inFlight.finally(() => {
          inFlight = null
        })
      }

      /** 停止 ComfyUI（Host 侧 /stop：先杀 pid 文件记录的进程，再兜底杀监听端口的 python）。 */
      const stopService = async () => {
        if (disposed || store.getSnapshot().stopping === true) return false
        store.set({ stopping: true })
        try {
          const response = await hostFetch('/stop', {
            method: 'POST',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          const data = await response.json().catch(() => null)
          const online = data !== null && data.online === true
          store.set({ online })
          if (response.ok && data !== null && (data.stopped === true || data.already === true)) {
            store.set({ entryState: 'idle' })
            return true
          }
          const detail = data !== null && typeof data.error === 'string' ? data.error : '停止失败（HTTP ' + response.status + '）'
          showToast(detail)
          reportClient({ where: 'stop', detail })
          return false
        } catch (error) {
          const detail = messageOf(error)
          showToast(detail)
          reportClient({ where: 'stop', detail })
          return false
        } finally {
          store.set({ stopping: false })
        }
      }

      ctx.effect(() => {
        return () => {
          disposed = true
          if (toastTimer !== null) window.clearTimeout(toastTimer)
          store.dispose()
        }
      }, 'dsh-drawing-agent: teardown')

      /* 轮询服务状态：入口右侧指示器要能反映"服务在不在"。页面隐藏时停表。 */
      ctx.effect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          const result = await probeStatus()
          if (!alive) return
          store.set({ online: result.online === true })
          timer = window.setTimeout(tick, 12000)
        }
        const onVisibility = () => {
          if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
          if (timer !== null) window.clearTimeout(timer)
          timer = window.setTimeout(tick, 200)
        }
        void tick()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          if (timer !== null) window.clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, 'dsh-drawing-agent: status polling')

      sharedProps = { store, tFallback: t, openEntry, openExternal, stopService, dismissToast: clearToast }


  
    /* 设置页：Civitai 凭据。token 只发给宿主凭据库，不回显、不写配置。 */
    function CivitaiSettings() {
      const [status, setStatus] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const refresh = React.useCallback(() => {
        fetch(API_PREFIX + '/cred').then((r) => r.json()).then(setStatus).catch(() => setStatus({ configured: false, error: '读不到凭据状态' }))
      }, [])
      React.useEffect(() => { refresh() }, [refresh])
      const save = () => {
        if (!draft.trim() || busy) return
        setBusy(true)
        fetch(API_PREFIX + '/cred', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: draft.trim() }) })
          .then((r) => r.json())
          .then((next) => { setStatus(next); setDraft(''); setNotice(next.error ? String(next.error) : '已保存到 DSH 凭据库') })
          .catch(() => setNotice('保存失败'))
          .finally(() => setBusy(false))
      }
      const clear = () => {
        if (busy) return
        setBusy(true)
        fetch(API_PREFIX + '/cred', { method: 'DELETE' })
          .then((r) => r.json())
          .then((next) => { setStatus(next); setNotice('已清除') })
          .catch(() => setNotice('清除失败'))
          .finally(() => setBusy(false))
      }
      const importLegacy = () => {
        if (busy) return
        setBusy(true)
        fetch(API_PREFIX + '/cred/import', { method: 'POST' })
          .then((r) => r.json())
          .then((next) => { setStatus(next.status ?? status); setNotice(next.imported ? '已从旧文件导入' : String(next.error ?? '导入失败')) })
          .catch(() => setNotice('导入失败'))
          .finally(() => setBusy(false))
      }
      const configured = Boolean(status && status.configured)
      const badge = configured
        ? h('span', { className: 'dshda-cred-badge ok' }, '已配置' + (status.source ? '（' + status.source + '）' : ''))
        : h('span', { className: 'dshda-cred-badge' }, '未配置')
      return h('div', { className: 'dshda-settings' },
        h('h2', null, 'AI 绘画'),
        h('h3', null, 'Civitai 凭据'),
        h('p', { className: 'dshda-settings-text' }, '下载需要登录的模型、或搜索结果受限时，需要一个 Civitai API token。token 只保存在 DSH 的凭据库（或环境变量 CIVITAI_TOKEN）里，不会写进配置、不会出现在模型上下文或日志。'),
        h('div', { className: 'dshda-cred-row' }, h('span', null, '状态'), badge),
        h('div', { className: 'dshda-cred-row' },
          h('input', {
            className: 'dshda-cred-input',
            type: 'password',
            placeholder: configured ? '已保存（重新输入可替换）' : '粘贴 Civitai API token',
            value: draft,
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') save() },
          }),
        ),
        h('div', { className: 'dshda-cred-actions' },
          h('button', { type: 'button', className: 'dshda-cred-btn primary', disabled: busy || !draft.trim(), onClick: save }, busy ? '处理中…' : '保存'),
          configured ? h('button', { type: 'button', className: 'dshda-cred-btn', disabled: busy, onClick: clear }, '清除') : null,
          status && status.legacyFile ? h('button', { type: 'button', className: 'dshda-cred-btn', disabled: busy, onClick: importLegacy, title: status.legacyFile }, '从旧文件导入') : null,
        ),
        notice ? h('div', { className: 'dshda-cred-notice' }, notice) : null,
        h('h3', null, '也可以用环境变量'),
        h('p', { className: 'dshda-settings-text' }, '不在这里保存时，设置环境变量 CIVITAI_TOKEN 后重启 DSH 即可；凭据库里的值优先于环境变量。'),
      )
    }

    /* 入口：Settings 上方那一行。这个座位只加一行按钮，不改变主面板选择，
         会话保持挂载，右栏导航（openTab）才有可写入的会话表面。 */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'drawing-console',
                order: 10,
                label: () => t('entry.label'),
              },
              GuardedFooterAction,
            ),
          ),
        'dsh-drawing-agent: footer entry',
      )

      /* 停止服务：ComfyUI 在线时才出现，紧挨着入口（order 11）。 */
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'drawing-console-stop',
                order: 11,
                label: () => t('stop.label'),
              },
              GuardedStopAction,
            ),
          ),
        'dsh-drawing-agent: footer stop',
      )

      /* 设置页：Civitai 凭据。token 走宿主凭据库，不经过模型。 */
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: '@luosuqwq/dsh-drawing-tools', order: 88, label: 'AI 绘画' },
              CivitaiSettings,
            ),
          ),
        'dsh-drawing-agent: civitai settings',
      )

      /* 失败提示条：只在出错时出现，不阻塞界面。 */
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'drawing-console-toast',
                order: 95,
              },
              GuardedFailureToast,
            ),
          ),
        'dsh-drawing-agent: failure toast',
      )
    }

    return { name: '@luosuqwq/dsh-drawing-tools', inject: ['slots', 'locale'], apply }
  },
})
