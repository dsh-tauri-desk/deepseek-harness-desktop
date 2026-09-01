/**
 * session.ts — 会话列表里给绑定工作树的会话行加 Git 分支图标（DOM 补丁）。
 *
 * 背景：会话行由官方 WorkspaceBrowser（sidebar.workspaces 单槽）内部渲染，
 * **没有** per-row 注入槽。因此采用「零结构补丁」：注入一条 CSS + MutationObserver，
 * 按语义结构（[role=treeitem]）而非生成的哈希类名（.YDXeBa_*）定位行，在行内
 * 「时间标识」左侧插入一个 Git 分支图标的 span。已完成「检出本地」的会话因
 * store 里 mode 回到 local，图标被移除。
 *
 * 注意：行没有 data-session-id 属性，使用 React `SessionNodeItem` Fiber key 读取精确
 * session id（只读，不移动 React 管理的节点），再读 store 判断是否处于工作树模式。
 */
import type { WorkspaceSessionOrder } from './types'
import { createLifecycleController, CssRender } from 'dsh-tauri/client'
import {
  SESSION_ICON_ATTRIBUTE,
  SESSION_ICON_STYLE_ID,
  SIDEBAR_SELECTOR,
} from './constants'
import { circleTreeSvg } from './icons'
import { worktreeStore } from './store'

export type { WorkspaceSessionOrder } from './types'

/**
 * 安装会话行分支图标（CSS + DOM 观察器）。返回卸载函数。
 * @returns 卸载函数。
 */
export function installSessionIcons(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  const controller = createLifecycleController()
  const cssr = CssRender()
  if (cssr.find(SESSION_ICON_STYLE_ID) !== null)
    return () => {}
  const { c } = cssr
  const iconStyle = c([
    c(`[${SESSION_ICON_ATTRIBUTE}]`, {
      width: '16px',
      height: '20px',
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: '2px',
      color: 'var(--dsw-alias-label-secondary)',
    }),
    c('[role="treeitem"]', { position: 'relative' }),
  ])
  iconStyle.mount({ id: SESSION_ICON_STYLE_ID, head: true })
  controller.add(() => iconStyle.unmount({ id: SESSION_ICON_STYLE_ID }))

  /**
   * HARDCODE: DSH 0.1.1-rc.2 does not expose a per-session-row slot or data id,
   * so read the private React Fiber key to avoid locale/title-based matching.
   */
  function reactKey(element: Element, prefix: 'session-' | ''): string | undefined {
    const fiberName = Object.keys(element).find(key => key.startsWith('__reactFiber$'))
    let fiber = fiberName ? (element as unknown as Record<string, any>)[fiberName] : undefined
    for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
      if (typeof fiber.key === 'string' && fiber.key.startsWith(prefix))
        return fiber.key
    }
  }

  function sessionRows(): Map<string, Element> {
    const rows = new Map<string, Element>()
    for (const row of document.querySelectorAll<Element>('[role="treeitem"][aria-selected]')) {
      const id = reactKey(row, 'session-')
      if (id)
        rows.set(id, row)
    }
    return rows
  }

  // HARDCODE: DSH 0.1.1-rc.2 SessionNodeItem children are status, title,
  // time, rowActions. Anchor on rowActions instead of locale-dependent text;
  // blank rows have no time, so never fall back to inserting before the title.
  function applyIcon(row: Element): void {
    if (row.querySelector(`[${SESSION_ICON_ATTRIBUTE}]`))
      return
    const actions = row.lastElementChild
    const time = actions?.previousElementSibling
    if (!actions?.querySelector('button') || !time || time.querySelector('button'))
      return

    const icon = document.createElement('span')
    icon.setAttribute(SESSION_ICON_ATTRIBUTE, '1')
    icon.style.marginRight = '5px'
    icon.innerHTML = circleTreeSvg(12)
    row.insertBefore(icon, time)
  }

  // 全量扫描：只绘制/清除图标，不移动 React 管理的 DOM。
  function scan(): void {
    const rows = sessionRows()
    const states = worktreeStore.getSnapshot().bySession
    for (const [sessionId, row] of rows) {
      const icon = row.querySelector<HTMLElement>(`[${SESSION_ICON_ATTRIBUTE}]`)
      if (states[sessionId]?.mode === 'worktree') {
        if (!icon)
          applyIcon(row)
      }
      else {
        icon?.remove()
      }
    }
  }

  // 观察 document.body（覆盖其后挂载的侧边栏子树），store 变更时重扫。
  controller.observe(document.body, { childList: true, subtree: true }, scan)
  controller.add(worktreeStore.subscribe(scan))

  // 应用晚挂载时侧边栏可能尚未出现，短暂轮询直到侧边栏出现即停（观察器已覆盖其子树）。
  const stopPolling = controller.interval(() => {
    if (document.querySelector(SIDEBAR_SELECTOR))
      stopPolling()
  }, 400)

  return () => controller.dispose()
}

/** 返回目标工作区与当前首个其他会话，供检出会话插到工作区最上方。 */
export function resolveWorkspaceTopInsertion(
  workspaces: readonly WorkspaceSessionOrder[],
  projectPath: string,
  targetSessionId: string,
): { workspaceId: string, beforeSessionId?: string } | undefined {
  const workspace = workspaces.find(item => item.path === projectPath)
  if (!workspace)
    return undefined
  return {
    workspaceId: workspace.workspaceId,
    beforeSessionId: workspace.sessionIds.find(id => id !== targetSessionId),
  }
}
