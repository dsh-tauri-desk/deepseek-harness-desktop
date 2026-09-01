/**
 * dom.ts — 面板的 DOM 逻辑（无 JSX）：侧栏导航判定 + 激活态投影。
 *
 * 与组件分离：shouldClosePanelForSidebarTarget 是纯 DOM 判定（可单测），
 * setSidebarPanelActive 把面板激活态投影到侧栏根供跨插件样式协议使用。
 */

import { PANEL_CLASSES, PANEL_DATA_ATTRIBUTES, SIDEBAR_INTERACTIVE_SELECTOR, SIDEBAR_KEEP_OPEN_SELECTOR, WORKSPACE_GROUP_SELECTOR } from '../constants'

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
export function setSidebarPanelActive(active: boolean): void {
  const sidebar = document.querySelector(`[${PANEL_DATA_ATTRIBUTES.sidebar}]`)
  if (active)
    sidebar?.setAttribute(PANEL_DATA_ATTRIBUTES.active, '')
  else
    sidebar?.removeAttribute(PANEL_DATA_ATTRIBUTES.active)
}

export { PANEL_CLASSES }
