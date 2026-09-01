import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { PanelActionItemProps, PanelContentSpec, PanelProtocol } from './types'
import { createExternalStore, createHooks } from 'dsh-tauri/client'
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
 *
 * Controller 化：会话区替换的全部可变状态（inject 句柄、当前规格、pointerdown
 * 监听）收敛进 createPanelConversationController() 创建的实例；installPanelService
 * 每次 apply 创建新实例，卸载时 close() 一次性释放，不再依赖模块级单例存活期。
 */

/** 替换状态（ActionItem active 样式订阅源；SnapshotStore 可安全保持模块级）。 */
const panelViewStore = createExternalStore<{ id: string } | null>(null)

/** 渲染 conversation 槽条目：包标记容器 + 宿主内容列（宽度约束由宿主决定，见 styles.ts）。 */
function ConversationSeat({ t, spec }: { t: (key: string) => string, spec: PanelContentSpec | undefined }): ReactElement | null {
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

/** 将面板激活态投影到侧栏根，供官方工作区行的跨插件样式协议使用。 */
function setSidebarPanelActive(active: boolean): void {
  const sidebar = document.querySelector(`[${PANEL_DATA_ATTRIBUTES.sidebar}]`)
  if (active)
    sidebar?.setAttribute(PANEL_DATA_ATTRIBUTES.active, '')
  else
    sidebar?.removeAttribute(PANEL_DATA_ATTRIBUTES.active)
}

/** 会话区替换控制器的对外形状（panel.protocol 的机制侧）。 */
export interface PanelConversationController {
  open: (ctx: Context, spec: PanelContentSpec) => void
  close: () => void
  toggle: (ctx: Context, spec: PanelContentSpec) => void
  viewId: () => { id: string } | null
}

/** 会话区替换的生命周期钩子（hookable：open/close 事件轴）。 */
export interface ConversationLifecycleHooks {
  'view:open': (spec: PanelContentSpec) => void
  'view:close': () => void
}

/**
 * 创建会话区替换控制器：拥有 inject 句柄、当前规格与 capture 层 pointerdown
 * 监听；close() 恢复官方会话界面并释放全部资源。open/close 走命名钩子
 * （hookable），供诊断与第三方联动。重复创建（插件重载）时旧实例先被其
 * effect 清理，互不干扰。
 */
export function createPanelConversationController(): PanelConversationController {
  const hooks = createHooks<ConversationLifecycleHooks>()
  let conversationSeat: (() => void) | undefined
  let currentSpec: PanelContentSpec | undefined
  let onPointerDownCapture: ((event: PointerEvent) => void) | undefined

  /** 打开会话区替换：动态注册 priority -1 的 conversation 条目。 */
  function open(ctx: Context, spec: PanelContentSpec): void {
    if (currentSpec && currentSpec.id === spec.id)
      return
    if (conversationSeat)
      close()
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
        // spec 经渲染期快照传入：close() 置空后条目已注销，组件自然卸载。
        (props: { t: (key: string) => string }) => <ConversationSeat t={props.t} spec={currentSpec} />,
      ))
    onPointerDownCapture = (event: PointerEvent): void => {
      if (shouldClosePanelForSidebarTarget(event.target instanceof Element ? event.target : null))
        close()
    }
    document.addEventListener('pointerdown', onPointerDownCapture, true)
    setSidebarPanelActive(true)
    void hooks.callHook('view:open', spec)
  }

  /** 关闭会话区替换：dispose inject 句柄 → 注销条目 → 官方 ui-conversation 恢复。 */
  function close(): void {
    conversationSeat?.()
    conversationSeat = undefined
    currentSpec = undefined
    panelViewStore.set(null)
    if (onPointerDownCapture) {
      document.removeEventListener('pointerdown', onPointerDownCapture, true)
      onPointerDownCapture = undefined
    }
    setSidebarPanelActive(false)
    void hooks.callHook('view:close')
  }

  return {
    open,
    close,
    toggle(ctx, spec) {
      if (currentSpec)
        close()
      else
        open(ctx, spec)
    },
    viewId: () => panelViewStore.getSnapshot(),
  }
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
 * 安装宿主服务：经 ctx.reflect.provide 暴露 panel.protocol（effect 生命周期，
 * 插件卸载即注销）。不依赖 renderer 补丁（conversation 注册只走 slots
 * runtime）——旧核心下内容区替换仍可用（仅面板区条目需 renderer）。
 * @param ctx - 客户端根上下文。
 */
export function installPanelService(ctx: Context): void {
  const controller = createPanelConversationController()
  const api: PanelProtocol = {
    ActionItem: PanelActionItem,
    renderPanelContent: spec => controller.toggle(ctx, spec),
    closePanelContent: () => controller.close(),
  }
  // Publish synchronously during apply: alpha slot injections can run before
  // sibling effects, so publishing from inside ctx.effect makes consumers see
  // an absent protocol and permanently skip their action registration.
  const disposeProtocol = ctx.reflect.provide(PANEL_PROTOCOL_SERVICE, api)
  ctx.effect(() => {
    return () => {
      controller.close()
      disposeProtocol()
    }
  }, 'dsh-tauri-panel: panel.protocol host service')
}
