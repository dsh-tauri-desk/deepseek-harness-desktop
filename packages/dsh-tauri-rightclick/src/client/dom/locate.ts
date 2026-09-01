/**
 * locate.ts — 从右键目标定位「会话行 / 工作区行」及官方操作按钮的 DOM 解析。
 *
 * 全部基于稳定的无障碍语义（[role=treeitem] / aria-label / aria-selected），
 * 不依赖生成哈希的 CSS module 类名；无法唯一确认目标时返回 null，保留浏览器
 * 默认菜单，避免操作错误的会话/工作区。
 */
import type {
  SessionsRuntimeLike,
  SessionSummaryLike,
  WorkspacesRuntimeLike,
  WorkspaceViewLike,
} from '../types'

/** 会话行「操作」按钮判定（zh/en 双语文案）。 */
export function isAction(button: Element): boolean {
  const label = (button.getAttribute('aria-label') || '').toLocaleLowerCase()
  return (label.includes('会话') && label.includes('操作')) || (label.includes('session') && label.includes('action'))
}

/** 工作区行「操作」按钮判定（zh/en 双语文案）。 */
export function isWorkspaceAction(button: Element): boolean {
  const label = (button.getAttribute('aria-label') || '').toLocaleLowerCase()
  return (label.includes('工作区') && label.includes('操作')) || (label.includes('workspace') && label.includes('action'))
}

/** 从目标元素向上找会话行（[role=treeitem]，带 aria-selected 或含操作按钮）。 */
export function rowFrom(target: unknown): Element | null {
  const row = target instanceof Element ? target.closest('[role="treeitem"]') : null
  if (!row)
    return null
  if (row.hasAttribute('aria-selected'))
    return row
  return [...row.querySelectorAll('button[aria-label]')].some(isAction) ? row : null
}

/** Locate the official Ungrouped group header, which intentionally has no menu button. */
export function ungroupedRowFrom(target: unknown): Element | null {
  const row = target instanceof Element ? target.closest('[role="treeitem"][aria-expanded]') : null
  if (!row)
    return null
  const label = [
    row.getAttribute('aria-label'),
    row.getAttribute('title'),
    ...[...row.querySelectorAll('span')]
      .filter(node => node.children.length === 0)
      .map(node => node.textContent?.trim() || ''),
  ].find(value => typeof value === 'string' && /^(?:未分组|Ungrouped)$/i.test(value))
  if (label === undefined || [...row.querySelectorAll('button[aria-label]')].some(isWorkspaceAction))
    return null
  return row
}

/** 行是否命中某个工作区（按 aria-label/title/纯文本三路匹配，要求唯一命中）。 */
function treeItemWorkspace(row: Element, items: readonly WorkspaceViewLike[]): WorkspaceViewLike | null {
  if (!row)
    return null
  const matches = items.filter((workspace) => {
    if ([row.getAttribute('aria-label'), row.getAttribute('title')].some(value => value?.trim() === workspace.title))
      return true
    return [...row.querySelectorAll('span,button,div')].some(node =>
      node.closest('[role="treeitem"]') === row
      && node.children.length === 0
      && node.textContent?.trim() === workspace.title)
  })
  return matches.length === 1 ? matches[0] : null
}

/** 从目标向上解析所属工作区（先沿祖先链，再回扫同级更上层行）。 */
export function workspaceFrom(target: unknown, workspaces: WorkspacesRuntimeLike): {
  workspace: WorkspaceViewLike
  row: Element
  targetRow: Element
} | null {
  const targetRow = target instanceof Element ? target.closest('[role="treeitem"]') : null
  if (!targetRow)
    return null
  const items = workspaces.list.getSnapshot().items
  for (let row: Element | null = targetRow; row; row = row.parentElement?.closest('[role="treeitem"]') ?? null) {
    const workspace = treeItemWorkspace(row, items)
    if (workspace)
      return { workspace, row, targetRow }
  }

  const rows = [...document.querySelectorAll('[role="treeitem"]')]
  const level = Number(targetRow.getAttribute('aria-level'))
  for (let index = rows.indexOf(targetRow) - 1; index >= 0; index -= 1) {
    const candidate = rows[index]
    const candidateLevel = Number(candidate.getAttribute('aria-level'))
    if (Number.isFinite(level) && Number.isFinite(candidateLevel) && candidateLevel >= level)
      continue
    if (rowFrom(candidate))
      continue
    const workspace = treeItemWorkspace(candidate, items)
    if (workspace)
      return { workspace, row: candidate, targetRow }
    if (Number.isFinite(level) && Number.isFinite(candidateLevel) && candidateLevel < level)
      break
  }
  return null
}

/** 行内的官方会话操作按钮（行内没有时按标题匹配全局操作按钮）。 */
export function officialAction(row: Element): HTMLButtonElement | null {
  const direct = [...row.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(isAction)
  if (direct)
    return direct
  const title = [...row.querySelectorAll('span')]
    .find(node => node.children.length === 0 && node.textContent?.trim())
    ?.textContent
    ?.trim()
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((button) => {
    if (!isAction(button))
      return false
    return !title || (button.getAttribute('aria-label') || '').includes(title)
  }) ?? null
}

/** 会话行标题：优先从操作按钮 aria-label 提取引号内标题，回退首个文本子节点。 */
export function titleFrom(row: Element): string {
  const label = [...row.querySelectorAll('button[aria-label]')].find(isAction)?.getAttribute('aria-label') || ''
  return label.match(/[“"](.+?)[”"]/)?.[1] || row.firstElementChild?.textContent?.trim() || ''
}

/** 解析行对应的会话对象（唯一匹配才返回；同名歧义时返回 null 保留默认菜单）。 */
export function resolveSession(
  sessions: SessionsRuntimeLike,
  row: Element,
  workspace: WorkspaceViewLike | null,
): SessionSummaryLike | null {
  const state = sessions.list.getSnapshot()
  if (row.getAttribute('aria-selected') === 'true' && state.current)
    return state.byId[state.current] || null
  const title = titleFrom(row)
  if (!title)
    return null
  const ids = workspace?.sessionIds || state.ids
  const matches = ids.map(id => state.byId[id]).filter(item =>
    item && (item.title === title
      || item.displayTitle === title
      || (item.blank && /^(?:新会话|new session)$/i.test(title))))
  return matches.length === 1 ? matches[0] : null
}

/** 会话所属工作区（按 sessionIds 归属反查）。 */
export function workspaceForSession(workspaces: WorkspacesRuntimeLike, session: SessionSummaryLike | null): WorkspaceViewLike | null {
  if (!session)
    return null
  return workspaces.list.getSnapshot().items.find(workspace => workspace.sessionIds.includes(session.id)) || null
}

/** 从目标向上找可编辑元素（input/textarea/contenteditable）。 */
export function editableFrom(target: unknown): HTMLElement | null {
  return target instanceof Element
    ? target.closest('input:not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]')
    : null
}

/** 当前选中文本（可编辑元素内取选区值；外层取全局选区，且须在可编辑元素内）。 */
export function selectedText(editable: HTMLElement | null): string {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)
    return editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0)
  const selection = globalThis.getSelection()
  if (!selection)
    return ''
  if (editable && (!editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode)))
    return ''
  return selection.toString()
}

/** 只接受 http/https 的 URL 校验（用于外链打开 / 选中文本里的网址）。 */
export function externalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}

/** 选中文本是否为完整网址（http/https 且无空格）。 */
export function selectedUrl(value: string): string | null {
  const text = value.trim()
  if (!/^https?:\/\/\S+$/i.test(text))
    return null
  return externalUrl(text)
}
