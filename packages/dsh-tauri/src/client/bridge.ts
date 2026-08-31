/**
 * 导航桥核心（iframe 内）：宿主（桌面壳层 ShellNavBar）↔ dsh 应用的消息协议。
 *
 * 消息（postMessage，双向）：
 * - 宿主 → iframe（命令）：`{ source: 'dsh-desktop', type }`
 *   - `dsh://sidebar:toggle`  切换侧边栏（转发 ctx.layout.toggleSidebar）
 *   - `dsh://page:prev`       后退（会话访问栈回退）
 *   - `dsh://page:next`       前进（会话访问栈前进）
 * - iframe → 宿主（事件）：`{ source: 'dsh-nav-bridge', type, ... }`
 *   - `dsh://sidebar:collapsed` `{ collapsed }` 侧边栏折叠状态
 *   - `dsh://page:firsted`      `{ firsted }` 已到访问栈最前（宿主应禁用后退）
 *   - `dsh://page:lasted`       `{ lasted }` 已到访问栈最后（宿主应禁用前进）
 *
 * 页面模型：dsh 应用不产生浏览器历史（无 pushState/hash 路由），因此「页面」=
 * 侧边栏当前选中的会话（`[role="treeitem"][aria-selected="true"]`）。本桥观察
 * 选中会话变化维护一个**会话访问栈**（纯内存）：用户点击会话 → 截断前进记录后
 * 追加新页并上报；后退/前进 → 点击栈内对应会话行让应用切回。
 *
 * 本桥与桌面端注入脚本（NAV_SHIM_JS）语义完全一致；插件加载后设置
 * `window.__dsh_tauri_bridge__`，注入脚本据此让位（避免命令/事件双重执行）。
 * 宿主仅接受 iframe 直接发来的消息（event.source === window.parent）。
 *
 * 桥内代码路径（观测器回调、导航、命令分发）统一经 `error.ts` 上报宿主：
 * key 与桌面端 `use-iframe-shim.ts` 校验保持一致，宿主持久化后「插件」面板
 * 显示 danger 标记，避免静默失败。
 */
import type { NavBridgeHandlers, Page } from './types'
import {
  CMD_NEXT,
  CMD_PREV,
  CMD_TOGGLE,
  EVENT_PAGE_FIRSTED,
  EVENT_PAGE_LASTED,
  EVENT_SIDEBAR_COLLAPSED,
  SESSION_LABEL_PATTERNS,
  SRC_BRIDGE,
  SRC_HOST,
  TRACK_INTERVAL_MS,
  TRACK_MAX_TRIES,
} from './constants'
import { guard, reportPluginError } from './error'

export type { NavBridgeHandlers } from './types'

/**
 * 安装导航桥：设置接管标记、挂载命令监听、侧边栏状态观察与会话访问栈跟踪。
 * @returns 卸载函数（插件重载/停用时清理，桌面端注入脚本随即恢复接管）。
 */
export function setupNavBridge(handlers: NavBridgeHandlers): () => void {
  // 接管标记：置位后桌面端 NAV_SHIM_JS 的命令与事件都让位
  window.__dsh_tauri_bridge__ = true

  function post(message: Record<string, unknown>): void {
    try {
      window.parent.postMessage(Object.assign({ source: SRC_BRIDGE }, message), '*')
    }
    catch {
      // 宿主已销毁等场景静默
    }
  }

  // ── AppFrame：dsh 应用布局的根（shell.overlay 的父节点）───────
  function findFrame(): HTMLElement | null {
    const overlay = document.querySelector<HTMLElement>('[data-shell-overlay]')
    return overlay ? (overlay.parentElement as HTMLElement | null) : null
  }

  // ── 侧边栏折叠状态（观察 AppFrame 的 data-sidebar-collapsed）────
  function collapsedOf(): boolean {
    const frame = findFrame()
    return !!(frame && frame.hasAttribute('data-sidebar-collapsed'))
  }

  const sidebarObserver = new MutationObserver(guard(() => {
    post({ type: EVENT_SIDEBAR_COLLAPSED, collapsed: collapsedOf() })
  }))

  // ── 会话访问栈（页面模型，纯内存）────────────────────────────
  let pages: Page[] = []
  let position = 0
  let lastKey: string | null = null
  /** 本桥触发的导航（后退/前进）落位中，观察器不应记录新页面。 */
  let suppress = false

  // 当前选中的会话行（AppFrame 侧边栏列内）
  function currentSelected(): HTMLElement | null {
    const frame = findFrame()
    const col = frame ? frame.firstElementChild : null
    if (!col)
      return null
    return col.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
  }

  // 行标题：从行内菜单按钮 aria-label 提取（zh/en），失败回退整行文本
  function rowTitle(row: HTMLElement | null): string {
    if (!row)
      return ''
    const btn = row.querySelector<HTMLElement>('button[aria-label]')
    const label = btn ? (btn.getAttribute('aria-label') || '') : ''
    for (const pattern of SESSION_LABEL_PATTERNS) {
      const match = pattern.exec(label)
      if (match)
        return match[1]!.trim()
    }
    return label || (row.textContent || '').trim()
  }

  // 按标题找会话行（行元素被重建后的兜底）
  function findRowByTitle(title: string): HTMLElement | null {
    if (!title)
      return null
    const frame = findFrame()
    const col = frame ? frame.firstElementChild : null
    if (!col)
      return null
    const rows = col.querySelectorAll<HTMLElement>('[role="treeitem"]')
    for (const row of rows) {
      if (rowTitle(row) === title)
        return row
    }
    return null
  }

  function reportPage(): void {
    post({ type: EVENT_PAGE_FIRSTED, firsted: position <= 0 })
    post({ type: EVENT_PAGE_LASTED, lasted: position >= pages.length - 1 })
  }

  // 用户导航到新会话：截断前进记录后追加
  function pushPage(key: string, el: HTMLElement | null): void {
    pages = pages.slice(0, position + 1).concat([{ key, el }])
    position = pages.length - 1
    reportPage()
  }

  // 后退/前进：切到栈内目标页（点击对应会话行让应用落位）
  function navigateTo(index: number): void {
    try {
      if (index < 0 || index >= pages.length)
        return
      const page = pages[index]!
      position = index
      const target = page.el && page.el.isConnected ? page.el : findRowByTitle(page.key ?? '')
      if (target) {
        suppress = true
        target.click()
      }
      reportPage()
    }
    catch (error) {
      // 行元素被重建/点击触发应用异常等：上报宿主，栈内记录保持一致
      reportPluginError(error, 'runtime')
    }
  }

  const onDomChange = guard(() => {
    const sel = currentSelected()
    const key = rowTitle(sel)
    if (key === lastKey)
      return
    lastKey = key
    if (suppress) {
      // 本桥导航落位：同步当前页记录（行元素可能被 React 重建）
      suppress = false
      if (pages[position] !== undefined) {
        pages[position] = { key, el: sel }
      }
      return
    }
    // 用户主动切换会话（无选中 = 欢迎/归档态，不入栈）
    if (key)
      pushPage(key, sel)
  })

  const pageObserver = new MutationObserver(onDomChange)

  // 初始化：应用挂载前无会话树，轮询补报直到拿到 AppFrame
  function startTrack(): boolean {
    try {
      const frame = findFrame()
      if (!frame)
        return false
      sidebarObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
      post({ type: EVENT_SIDEBAR_COLLAPSED, collapsed: collapsedOf() })

      const sel = currentSelected()
      const key = rowTitle(sel)
      lastKey = key
      // 根页：当前选中的会话（无选中时以「欢迎页」为根，首个会话打开即入栈）
      pages = [{ key: key || null, el: sel }]
      position = 0
      pageObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected'],
      })
      reportPage()
      return true
    }
    catch (error) {
      // 布局结构异常等：上报宿主并返回 false，轮询会继续补报直到成功
      reportPluginError(error, 'runtime')
      return false
    }
  }

  // ── 宿主命令接收 ──────────────────────────────────────────────
  function onMessage(event: MessageEvent<unknown>): void {
    // 只接受宿主窗口直发的命令；不兼容多层嵌套 iframe
    if (event.source !== window.parent)
      return
    const data = event.data as { source?: string, type?: string } | null
    if (!data || typeof data !== 'object' || data.source !== SRC_HOST)
      return
    try {
      switch (data.type) {
        case CMD_TOGGLE:
          handlers.toggleSidebar()
          break
        case CMD_PREV:
          navigateTo(position - 1)
          break
        case CMD_NEXT:
          navigateTo(position + 1)
          break
      }
    }
    catch (error) {
      // 命令处理（layout 切换/导航）抛错：上报宿主，不中断后续命令
      reportPluginError(error, 'runtime')
    }
  }
  window.addEventListener('message', onMessage)

  // ── 初始化 + 应用晚挂载的轮询补报 ──────────────────────────
  let trackTimer: ReturnType<typeof setInterval> | undefined
  if (!startTrack()) {
    let tries = 0
    trackTimer = setInterval(() => {
      if (startTrack() || ++tries > TRACK_MAX_TRIES) {
        clearInterval(trackTimer)
      }
    }, TRACK_INTERVAL_MS)
  }

  // ── 卸载 ──────────────────────────────────────────────────────
  return () => {
    delete window.__dsh_tauri_bridge__
    window.removeEventListener('message', onMessage)
    sidebarObserver.disconnect()
    pageObserver.disconnect()
    if (trackTimer !== undefined)
      clearInterval(trackTimer)
  }
}
