import type { Root } from 'react-dom/client'
/**
 * workspace-patch.ts — 在官方工作区浏览器里为「删除工作区」补一个「归档工作区」。
 *
 * 官方 WorkspaceBrowser 的「删除工作区」不是侧边栏里的独立按钮，而是项目行
 * 「…」菜单（primitives `Menu`，portal 渲染到 document.body）里的一个条目
 * `button[role=menuitem]`。本补丁做两件事：
 *   1. 监听每个项目行（`[role=treeitem][aria-expanded]`）的「…」按钮点击，
 *      按行标题与运行时快照唯一匹配记录该行的工作区 id；
 *   2. 扫描 document.body 的 portal 菜单：保留官方「删除工作区」条目原样
 *      （官方 Modal 确认，非破坏性：文件夹与会话记录保留，会话归入未分组），
 *      在其前插入「归档工作区」条目（删除条目保持最底），点击 → 客户端样式确认框 → 归档该组全部会话。
 *
 * 归档目标与会话清单全部来自运行时快照（workspace.sessionIds），不依赖
 * 「组容器里装得下会话行」的 DOM 启发式——官方浏览器在组折叠时不渲染会话行，
 * 旧实现会因此「全部折叠时无动作、部分展开时错归档到相邻工作区」（#235）。
 *
 * 归档后会话由宿主归档集合隐藏（官方浏览器按 archivedSessionIds 过滤），
 * 无需本插件再做行隐藏。
 */
import type { SessionsRuntimeLike, WorkspacesRuntimeLike, WorkspaceViewLike } from './types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DELETE_WORKSPACE_LABELS,
  SESSION_CLASSES as K,
  MENU_ITEM_SELECTOR,
  SIDEBAR_SELECTOR,
  WORKSPACE_MENU_ANCHOR_ATTRIBUTE,
  WORKSPACE_MENU_PATCH_ATTRIBUTE,
} from './constants'
import { text } from './locale'
import { archiveSession, archiveWorkspace } from './store'

/** 归档条目图标（gravity-ui archive 的 path，与归档设置页一致）。 */
const ARCHIVE_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2429 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z" fill="currentColor"/></svg>'

/**
 * 从 React Fiber key 里读 session id（只读，不移动 React 管理的节点）。
 * 参照 dsh-tauri-worktree/src/client/session.ts 的 HARDCODE 技法。
 */
function reactKey(element: Element, prefix: 'session-' | ''): string | undefined {
  const fiberName = Object.keys(element).find(key => key.startsWith('__reactFiber$'))
  let fiber = fiberName ? (element as unknown as Record<string, any>)[fiberName] : undefined
  for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
    if (typeof fiber.key === 'string' && fiber.key.startsWith(prefix))
      return fiber.key
  }
}

/** 收集一个工作区组容器里的全部会话 id（仅作标题匹配失败的兜底）。 */
function collectSessionIds(group: Element, sessionsRuntime: SessionsRuntimeLike): string[] {
  const ids = new Set<string>()
  const sessionSnapshot = sessionsRuntime.list.getSnapshot()
  for (const row of group.querySelectorAll<Element>('[role="treeitem"][aria-selected]')) {
    const id = reactKey(row, 'session-')
    if (id && sessionSnapshot?.byId[id]?.blank !== true)
      ids.add(id)
  }
  return [...ids]
}

/** 解析节点所隶属的工作区组容器（向上找最近的、同时装得下会话行的祖先）。 */
function workspaceGroupOf(node: Element): Element | undefined {
  let current = node.parentElement
  for (let depth = 0; current && depth < 12; depth++, current = current.parentElement) {
    if (current.querySelector('[role="treeitem"][aria-selected]'))
      return current
  }
  return undefined
}

/**
 * 从项目行解析工作区（按 aria-label/title/纯文本与运行时快照唯一匹配）。
 * 官方行标题即工作区标题（重名被官方重命名拦截），唯一命中才返回。
 * 空白/缺失标题的工作区不参与匹配，避免与行内空文本节点误命中。
 */
export function workspaceFromRow(row: Element, workspacesRuntime: WorkspacesRuntimeLike): WorkspaceViewLike | null {
  const items = [...workspacesRuntime.list.getSnapshot().items]
  const matches = items.filter((workspace) => {
    const title = workspace.title?.trim()
    if (!title)
      return false
    if ([row.getAttribute('aria-label'), row.getAttribute('title')].some(value => value?.trim() === title))
      return true
    return [...row.querySelectorAll('span,button,div')].some(node =>
      node.closest('[role="treeitem"]') === row
      && node.children.length === 0
      && node.textContent?.trim() === title)
  })
  return matches.length === 1 ? matches[0] : null
}

/**
 * 解析工作区归档清单：只统计官方浏览器会展示的真实会话。
 * subagent 会话、空白占位会话和运行时缺失摘要的 id 不显示在工作区组中，
 * 因而不应计入「归档 N 个会话」的 N（#235）。
 */
export function collectWorkspaceSessionIds(
  workspace: WorkspaceViewLike,
  workspacesRuntime: WorkspacesRuntimeLike,
  sessionsRuntime: SessionsRuntimeLike,
): string[] {
  const archived = new Set(workspacesRuntime.list.getSnapshot().archivedSessionIds ?? [])
  const byId = sessionsRuntime.list.getSnapshot().byId
  return workspace.sessionIds.filter((id) => {
    if (archived.has(id))
      return false
    const session = byId[id]
    return session !== undefined && session.blank !== true && session.origin !== 'subagent'
  })
}

/**
 * 安装工作区浏览器补丁。返回卸载函数。
 * @param workspacesRuntime - 客户端 ctx.workspaces（归档目标与会话清单来源）。
 * @param sessionsRuntime - 客户端 ctx.sessions（仅兜底 DOM 收集用）。
 */
export function installWorkspaceArchivePatch(workspacesRuntime: WorkspacesRuntimeLike, sessionsRuntime: SessionsRuntimeLike): () => void {
  if (typeof document === 'undefined')
    return () => {}

  /** 最近一次打开的工作区「…」菜单所隶属的工作区（运行时解析）。 */
  let pendingWorkspace: WorkspaceViewLike | undefined
  /** 兜底：标题匹配失败时退回的组容器（历史 DOM 启发式）。 */
  let pendingGroup: Element | undefined
  let dialogRoot: Root | undefined
  let dialogHost: HTMLDivElement | undefined
  /** 菜单条目清理器：与条目元素关联，元素脱离文档后即被丢弃。 */
  const itemCleanups: Array<{ element: HTMLElement, cleanup: () => void }> = []
  /** 行「…」按钮清理器：与按钮元素关联，行被官方替换后即被丢弃。 */
  const rowCleanups: Array<{ element: HTMLElement, cleanup: () => void }> = []

  /** 关闭归档确认对话框并清理宿主节点（幂等）。 */
  function closeDialog(): void {
    dialogRoot?.unmount()
    dialogRoot = undefined
    dialogHost?.remove()
    dialogHost = undefined
  }

  function openArchiveDialog(workspace: WorkspaceViewLike | undefined, sessionIds: string[]): void {
    // 先关闭可能残留的旧对话框，避免宿主节点与 React root 泄漏。
    closeDialog()
    const workspaceTitle = workspace?.title ?? workspace?.path.split(/[\\/]/).pop() ?? text('ungrouped')
    dialogHost = document.createElement('div')
    document.body.append(dialogHost)
    dialogRoot = createRoot(dialogHost)
    const confirm = (): void => {
      closeDialog()
      void archiveGroup(workspace, sessionIds)
    }
    dialogRoot.render(createElement(Modal, {
      open: true,
      onClose: closeDialog,
      title: text('archiveWorkspaceTitle', { count: sessionIds.length }),
      description: text('archiveWorkspaceDescription', { workspace: workspaceTitle }),
      footer: createElement('div', {}, createElement(Button, { variant: 'ghost', onClick: closeDialog, style: { marginRight: 6 } }, text('cancel')), createElement(Button, { variant: 'outline', onClick: confirm }, text('archiveWorkspaceConfirm'))),
    }))
  }

  /** 归档一个工作区组（点击「归档工作区」后触发）。 */
  async function archiveGroup(workspace: WorkspaceViewLike | undefined, sessionIds: string[]): Promise<void> {
    if (workspace)
      await archiveWorkspace(workspace.workspaceId, sessionIds)
    else
      await Promise.all(sessionIds.map(id => archiveSession(id)))
  }

  /** 项目行「…」按钮点击时记录其工作区（会话行菜单不记录）。 */
  function recordAnchor(button: Element): void {
    pendingWorkspace = undefined
    pendingGroup = undefined
    const row = button.closest('[role="treeitem"]')
    // 项目行带 aria-expanded；会话行带 aria-selected —— 只记录前者。
    if (!row || row.hasAttribute('aria-selected'))
      return
    const workspace = workspaceFromRow(row, workspacesRuntime)
    if (workspace) {
      pendingWorkspace = workspace
      return
    }
    // 标题匹配失败（如重名工作区）时退回 DOM 组容器启发式（历史行为）。
    const group = workspaceGroupOf(row)
    if (group)
      pendingGroup = group
  }

  /** 为项目行「…」按钮挂一次性记录监听（capture 阶段先于 React 打开菜单）。 */
  function watchRow(row: HTMLElement): void {
    const ellipsis = row.querySelector<HTMLElement>('button')
    if (!ellipsis || ellipsis.hasAttribute(WORKSPACE_MENU_ANCHOR_ATTRIBUTE))
      return
    ellipsis.setAttribute(WORKSPACE_MENU_ANCHOR_ATTRIBUTE, '1')
    const onAnchorClick = (): void => recordAnchor(ellipsis)
    ellipsis.addEventListener('click', onAnchorClick, { capture: true })
    rowCleanups.push({
      element: ellipsis,
      cleanup: () => {
        ellipsis.removeEventListener('click', onAnchorClick, { capture: true })
        ellipsis.removeAttribute(WORKSPACE_MENU_ANCHOR_ATTRIBUTE)
      },
    })
  }

  /**
   * 替换菜单条目文案。返回是否找到官方 label 节点 —— 找不到（非官方 primitives
   * 结构，如其他插件的自绘菜单按钮）时返回 false，调用方中止 patch，绝不追加
   * 文本节点造成「删除工作区归档工作区」式粘连。
   */
  function setItemLabel(item: HTMLElement, label: string): boolean {
    const labelNode = item.querySelector<HTMLElement>('[class*="itemLabel"], [class*="label"]')
    if (labelNode) {
      labelNode.textContent = label
      return true
    }
    return false
  }

  /**
   * 给一个 portal 菜单追加「归档工作区」条目；官方「删除工作区」条目保持原样。
   * 克隆官方条目以继承 primitives 菜单样式，只替换文案/图标与点击行为。
   * 同一菜单只处理一次（菜单关闭即从 DOM 消失，下次打开是全新节点）。
   */
  function patchWorkspaceMenu(item: HTMLButtonElement): void {
    const menu = item.closest<HTMLElement>('[role="menu"]')
    if (!menu || menu.hasAttribute(WORKSPACE_MENU_PATCH_ATTRIBUTE))
      return
    menu.setAttribute(WORKSPACE_MENU_PATCH_ATTRIBUTE, '1')

    const archiveItem = item.cloneNode(true) as HTMLButtonElement
    // 克隆的文案替换失败（条目不是官方 primitives 结构）时不插入，避免文本粘连。
    if (!setItemLabel(archiveItem, text('archiveWorkspaceMenu')))
      return
    const icon = archiveItem.querySelector<HTMLElement>('[class*="itemIcon"]')
    if (icon)
      icon.innerHTML = ARCHIVE_ICON_SVG
    // 删除条目带 danger 样式，归档条目需要还原成普通条目外观。
    archiveItem.classList.add(K.archiveMenuItem)
    archiveItem.style.setProperty('color', 'var(--dsw-alias-label-primary)', 'important')
    archiveItem.style.setProperty('background', 'transparent', 'important')
    icon?.style.setProperty('color', 'var(--dsw-alias-label-tertiary)', 'important')
    const onEnter = (): void => archiveItem.style.setProperty('background', 'var(--dsw-alias-interactive-bg-hover)', 'important')
    const onLeave = (): void => archiveItem.style.setProperty('background', 'transparent', 'important')
    archiveItem.addEventListener('mouseenter', onEnter)
    archiveItem.addEventListener('mouseleave', onLeave)
    const onClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const workspace = pendingWorkspace
      let sessionIds: string[] | undefined
      if (workspace) {
        // 运行时快照与会话归属即权威：折叠/空工作区也能正确定位；计数与
        // 官方行可见性一致，排除 subagent、空白占位和缺失摘要的会话。
        sessionIds = collectWorkspaceSessionIds(workspace, workspacesRuntime, sessionsRuntime)
      }
      else if (pendingGroup) {
        sessionIds = collectSessionIds(pendingGroup, sessionsRuntime)
      }
      if (!sessionIds || sessionIds.length === 0)
        return
      openArchiveDialog(workspace, sessionIds)
      // 克隆条目不会触发官方的 onSelect（菜单不会自行关闭），派发一次外部
      // pointerdown 触发 primitives Menu 的 onClose。
      const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
      document.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, cancelable: true }))
    }
    archiveItem.addEventListener('click', onClick, { capture: true })
    // 归档条目插在删除条目之前，官方「删除工作区」保持菜单最底（#235 菜单顺序回归）。
    item.before(archiveItem)
    itemCleanups.push({
      element: archiveItem,
      cleanup: () => {
        archiveItem.removeEventListener('mouseenter', onEnter)
        archiveItem.removeEventListener('mouseleave', onLeave)
        archiveItem.removeEventListener('click', onClick, { capture: true })
      },
    })
  }

  /**
   * 全量扫描：项目行记录监听 + portal 菜单追加归档条目。
   * MutationObserver 每次 DOM 变化都会触发；guard 属性保证每项只处理一次。
   */
  function scan(): void {
    // 丢弃已脱离文档的菜单条目/行清理器，避免数组随菜单反复开关、行被官方
    // 替换而无限增长（脱离文档的监听器随元素 GC，无需逐个执行 cleanup）。
    for (let index = itemCleanups.length - 1; index >= 0; index--) {
      if (!itemCleanups[index].element.isConnected)
        itemCleanups.splice(index, 1)
    }
    for (let index = rowCleanups.length - 1; index >= 0; index--) {
      if (!rowCleanups[index].element.isConnected)
        rowCleanups.splice(index, 1)
    }
    const sidebar = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR)
    if (sidebar) {
      for (const row of sidebar.querySelectorAll<HTMLElement>('[role="treeitem"][aria-expanded]'))
        watchRow(row)
    }
    for (const item of document.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)) {
      const label = item.textContent?.trim() ?? ''
      if (!label)
        continue
      // 只处理官方 primitives 菜单条目：官方条目由 `itemWrap` 包裹，其他插件
      // （如右键菜单）自绘的 `button[role=menuitem]` 没有该结构 —— 误 patch
      // 会把克隆项插进别人的菜单并在文案替换失败时造成文本粘连（#235）。
      if (!item.closest('[class*="itemWrap"]'))
        continue
      if (DELETE_WORKSPACE_LABELS.includes(label) || DELETE_WORKSPACE_LABELS.some(needle => label.includes(needle)))
        patchWorkspaceMenu(item)
    }
  }

  const ro = new MutationObserver(scan)
  let timer: ReturnType<typeof setInterval> | undefined
  let tries = 0
  /** 首次挂载：侧边栏就绪后开始观察并执行首轮扫描；未就绪时由调用方轮询重试。 */
  function attach(): boolean {
    const sidebar = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR)
    if (!sidebar)
      return false
    ro.observe(document.body, { childList: true, subtree: true })
    scan()
    return true
  }

  if (!attach()) {
    timer = setInterval(() => {
      if (attach() || ++tries > 30)
        clearInterval(timer)
    }, 500)
  }

  return () => {
    ro.disconnect()
    closeDialog()
    for (const { cleanup } of itemCleanups)
      cleanup()
    itemCleanups.length = 0
    for (const { cleanup } of rowCleanups)
      cleanup()
    rowCleanups.length = 0
    if (timer !== undefined)
      clearInterval(timer)
  }
}
