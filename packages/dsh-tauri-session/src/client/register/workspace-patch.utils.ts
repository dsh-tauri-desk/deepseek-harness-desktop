import type { SessionsRuntimeLike, WorkspacesRuntimeLike, WorkspaceViewLike } from '../types/runtime'
import {
  ARCHIVE_MENU_ITEM_ATTRIBUTE,
  ARCHIVE_MENU_ITEM_CLASS,
  DELETE_WORKSPACE_LABELS,
  MENU_ITEM_ICON_SELECTOR,
  MENU_ITEM_LABEL_SELECTOR,
  MENU_ITEM_WRAP_SELECTOR,
} from '../constants'
import { ARCHIVE_MENU_ICON_SVG } from '../constants/archive-icon'

/**
 * 从项目行解析工作区（按 aria-label/title/纯文本与运行时快照唯一匹配）。
 * 官方行标题即工作区标题（重名被官方重命名拦截），唯一命中才返回；空白/缺失标题
 * 的工作区不参与匹配，避免与行内空文本节点误命中。
 */
export function workspaceFromRow(row: Element, workspaces: WorkspacesRuntimeLike): WorkspaceViewLike | null {
  const matches = workspaces.list.getSnapshot().items.filter((workspace) => {
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
 * 因而不计入「归档 N 个会话」的 N。
 */
export function collectWorkspaceSessionIds(
  workspace: WorkspaceViewLike,
  workspaces: WorkspacesRuntimeLike,
  sessions: SessionsRuntimeLike,
): string[] {
  const archived = new Set(workspaces.list.getSnapshot().archivedSessionIds ?? [])
  const byId = sessions.list.getSnapshot().byId
  return workspace.sessionIds.filter((id) => {
    if (archived.has(id))
      return false
    const session = byId[id]
    return session !== undefined && session.blank !== true && session.origin !== 'subagent'
  })
}

/**
 * 只识别官方 primitives 菜单条目：官方条目由 `itemWrap` 包裹，其他插件（如右键菜单）
 * 自绘的 `button[role=menuitem]` 没有该结构 —— 误 patch 会把克隆项插进别人的菜单。
 */
export function isDeleteWorkspaceMenuItem(item: HTMLElement): boolean {
  if (!item.closest(MENU_ITEM_WRAP_SELECTOR))
    return false
  const label = item.textContent?.trim() ?? ''
  return label.length > 0 && DELETE_WORKSPACE_LABELS.some(needle => label.includes(needle))
}

/**
 * 把官方「删除工作区」条目的克隆改造成「归档工作区」条目。
 * 返回是否改造成功 —— 文案替换失败（非官方 primitives 结构）时返回 false，
 * 调用方中止插入，绝不追加文本节点造成「删除工作区归档工作区」式粘连。
 */
export function decorateArchiveMenuItem(item: HTMLButtonElement, label: string): boolean {
  const labelNode = item.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR)
  if (!labelNode)
    return false
  labelNode.textContent = label
  // danger 外观由 `.dshp-session__archive-menu-item` 的 !important 覆盖（见 styles/workspace-menu.cssr）。
  item.classList.add(ARCHIVE_MENU_ITEM_CLASS)
  item.setAttribute(ARCHIVE_MENU_ITEM_ATTRIBUTE, '1')
  const icon = item.querySelector<HTMLElement>(MENU_ITEM_ICON_SELECTOR)
  if (icon)
    icon.innerHTML = ARCHIVE_MENU_ICON_SVG
  return true
}
