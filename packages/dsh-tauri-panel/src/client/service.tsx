import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { PanelActionItemProps, PanelContentSpec, PanelProtocol } from './types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { PANEL_CLASSES, PANEL_DATA_ATTRIBUTES, PANEL_PROTOCOL_SERVICE, PANEL_VIEW_COMPONENT_ID, PANEL_VIEW_SLOT, SIDEBAR_INTERACTIVE_SELECTOR, SIDEBAR_KEEP_OPEN_SELECTOR, WORKSPACE_GROUP_SELECTOR } from './constants'
import { NS } from './locale'

export type { PanelActionItemProps, PanelContentSpec, PanelProtocol } from './types'

/**
 * service.tsx — 面板协议宿主服务（协议能力，见 PROTOCOL.md）。
 *
 * 宿主对外只暴露两个构件，子插件无需处理任何状态/机制：
 *   - `<ActionItem>`：面板区条目组件（样式、折叠态、active 态全由宿主承担）；
 *   - `renderPanelContent(spec)`：切换会话区替换（conversation 槽条件 shadow），
 *     子插件在 ActionItem 的 onClick 里调用。
 *
 * 机制（全部在宿主，单一权威）：
 *   - 服务经 ctx.reflect.provide('panel.protocol', api) 暴露（cordis
 *     ReflectService，官方 runtime 同款用法 ctx.reflect.provide("sessions", this)）；
 *   - renderPanelContent：conversation 槽（single/session-maybe，layout 声明、
 *     官方 ui-conversation priority 0 是唯一注册者）以 priority -1 **动态注册**
 *     → 整个右侧会话区被替换（CenterColumn 内、零定位层）；官方条目被
 *     shadow 但仍 live（children/locale 有效）。再调（同 id）→ dispose 句柄
 *     → 官方恢复（toggle 语义）。
 *   - 替换状态存共享 snapshot store：ActionItem 经 useSyncExternalStore
 *     感知「当前替换 id === 自己 id」→ 保持 active（hover）样式。
 *   - 退出时机：无关闭按钮——document capture 层监听 pointerdown，只在侧栏
 *     内的有效导航/操作控件被点击时恢复官方会话界面；空白区、面板条目和只
 *     改变工作区列表呈现的控件（工作区折叠行、分组、添加工作区）保持面板。
 *     右侧区域（第三方悬浮按钮等）不影响替换，避免误关。
 *
 * 不能常驻注册 + SlotOutlet 透传：SlotOutlet 对 single 槽只渲染 live 条目，
 * 自己 live 后渲染官方条目 = 自递归（无公开 API 渲染被 shadow 条目）。
 */

/** 当前 conversation 替换的 inject 句柄（undefined = 官方会话区 live）。 */
let conversationSeat: (() => void) | undefined
/** 当前替换视图规格。 */
let currentSpec: PanelContentSpec | undefined
/** 替换状态（ActionItem active 样式订阅源）。 */
const panelViewStore = createExternalStore<{ id: string } | null>(null)
/** 根上下文（renderPanelContent 内部注册用）。 */
let rootCtx: Context | undefined

/** 渲染 conversation 槽条目：包标记容器 + 宿主内容列（宽度约束由宿主决定，见 styles.ts）。 */
function ConversationSeat({ t }: { t: (key: string) => string }): ReactElement | null {
  const spec = currentSpec
  if (!spec)
    return null
  const View = spec.render
  return (
    <div {...{ [PANEL_DATA_ATTRIBUTES.view]: '' }} className={PANEL_CLASSES.panelView}>
      {/* 内容列：对齐官方内容列宽度（max-width var(--dsh-chat-content-width, 748px)），
          子插件零宽度关注，只负责内容自身布局（垂直方向自定）。 */}
      <div style={{ padding: '16px 16px 16px 8px' }}>
        <div className={PANEL_CLASSES.panelViewColumn}>
          <View t={t} />
        </div>
      </div>
    </div>
  )
}

/**
 * 判断侧栏 pointerdown 是否代表离开当前面板的导航动作：
 *   - 面板视图/条目与空白区不是动作，保持面板；
 *   - 只改变侧栏呈现的控件保持面板（工作区“分组方式”“添加工作区”按钮，
 *     以及工作区折叠行本体——折叠行内的菜单/新建按钮仍是动作，会关闭）；
 *   - 其余在侧栏内的可交互控件（会话行、搜索结果、设置等）视为导航，关闭。
 */
export function shouldClosePanelForSidebarTarget(target: Element | null): boolean {
  if (!target)
    return false
  const sidebar = target.closest(`[${PANEL_DATA_ATTRIBUTES.sidebar}]`)
  if (!sidebar)
    return false
  if (target.closest(`[${PANEL_DATA_ATTRIBUTES.view}],[${PANEL_DATA_ATTRIBUTES.action}]`))
    return false
  if (target.closest(SIDEBAR_KEEP_OPEN_SELECTOR))
    return false

  const interactive = target.closest(SIDEBAR_INTERACTIVE_SELECTOR)
  if (!interactive || !sidebar.contains(interactive))
    return false

  // 工作区折叠行本身不在可交互集合内（自然保持面板）；嵌套按钮（工作区菜单、
  // 新建会话）是真实动作，按自身语义关闭。
  const workspaceGroup = target.closest(WORKSPACE_GROUP_SELECTOR)
  return workspaceGroup === null || interactive !== workspaceGroup
}

/** 捕获侧栏导航动作并在目标自身的 click 行为执行前恢复官方会话区。 */
function onPointerDownCapture(event: PointerEvent): void {
  if (!conversationSeat)
    return
  if (shouldClosePanelForSidebarTarget(event.target instanceof Element ? event.target : null))
    closeConversation()
}

/** 将面板激活态投影到侧栏根，供官方工作区行的跨插件样式协议使用。 */
function setSidebarPanelActive(active: boolean): void {
  const sidebar = document.querySelector(`[${PANEL_DATA_ATTRIBUTES.sidebar}]`)
  if (active)
    sidebar?.setAttribute(PANEL_DATA_ATTRIBUTES.active, '')
  else
    sidebar?.removeAttribute(PANEL_DATA_ATTRIBUTES.active)
}

/** 打开会话区替换：动态注册 priority -1 的 conversation 条目。 */
function openConversation(ctx: Context, spec: PanelContentSpec): void {
  if (currentSpec && currentSpec.id === spec.id)
    return
  if (conversationSeat)
    closeConversation()
  currentSpec = spec
  panelViewStore.set({ id: spec.id })
  conversationSeat = ctx.slots.inject(PANEL_VIEW_SLOT as never, () =>
    ctx.slots.register(
      {
        name: PANEL_VIEW_SLOT,
        id: PANEL_VIEW_COMPONENT_ID,
        priority: -1,
        locale: spec.locale ?? NS,
      } as never,
      ConversationSeat,
    ))
  document.addEventListener('pointerdown', onPointerDownCapture, true)
  setSidebarPanelActive(true)
}

/** 关闭会话区替换：dispose inject 句柄 → 注销条目 → 官方 ui-conversation 恢复。 */
function closeConversation(): void {
  conversationSeat?.()
  conversationSeat = undefined
  currentSpec = undefined
  panelViewStore.set(null)
  document.removeEventListener('pointerdown', onPointerDownCapture, true)
  setSidebarPanelActive(false)
}

/** 订阅当前替换 id（null = 官方会话区）。 */
function usePanelViewId(): { id: string } | null {
  return useSyncExternalStore(
    fn => panelViewStore.subscribe(fn),
    () => panelViewStore.getSnapshot(),
  )
}

/** ActionItem：面板区条目（样式/折叠/active 态全宿主，子插件只填内容与行为）。 */
export function PanelActionItem({ id, icon, onClick, children }: PanelActionItemProps): ReactElement {
  const active = usePanelViewId()?.id === id
  return (
    <button
      type="button"
      className={active ? `${PANEL_CLASSES.menuItem} ${PANEL_CLASSES.menuItemSelected}` : PANEL_CLASSES.menuItem}
      {...{ [PANEL_DATA_ATTRIBUTES.action]: '' }}
      onClick={onClick}
    >
      {icon !== undefined && <span className={PANEL_CLASSES.menuItemIcon}>{icon}</span>}
      <span className={PANEL_CLASSES.menuItemLabel}>{children}</span>
    </button>
  )
}

/**
 * 切换会话区替换：未替换则打开（conversation 槽动态注册 spec.render），
 * 已替换则关闭恢复官方会话界面。子插件在 ActionItem 的 onClick 里调用。
 * @param spec - 内容区规格。
 */
export function renderPanelContent(spec: PanelContentSpec): void {
  if (!rootCtx)
    return
  if (conversationSeat)
    closeConversation()
  else
    openConversation(rootCtx, spec)
}

/** 显式关闭当前面板内容；未打开面板时为空操作。 */
export function closePanelContent(): void {
  if (conversationSeat)
    closeConversation()
}

/**
 * 安装宿主服务：经 ctx.reflect.provide 暴露 panel.protocol（effect 生命周期，
 * 插件卸载即注销）。不依赖 renderer 补丁（conversation 注册只走 slots
 * runtime）——旧核心下内容区替换仍可用（仅面板区条目需 renderer）。
 * @param ctx - 客户端根上下文。
 */
export function installPanelService(ctx: Context): void {
  const api: PanelProtocol = {
    ActionItem: PanelActionItem,
    renderPanelContent,
    closePanelContent,
  }
  // Publish synchronously during apply: alpha slot injections can run before
  // sibling effects, so publishing from inside ctx.effect makes consumers see
  // an absent protocol and permanently skip their action registration.
  rootCtx = ctx
  const disposeProtocol = ctx.reflect.provide(PANEL_PROTOCOL_SERVICE, api)
  ctx.effect(() => {
    return () => {
      if (rootCtx === ctx) {
        closePanelContent()
        rootCtx = undefined
      }
      disposeProtocol()
    }
  }, 'dsh-tauri-panel: panel.protocol host service')
}
