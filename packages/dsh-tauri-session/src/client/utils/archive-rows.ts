/**
 * client/utils/archive-rows.ts — 归档列表的纯函数：行构建 / 去重 / 标题与时间格式化。
 * 从 panel.tsx 剥离，便于单测与复用。
 */

import type { ArchiveRow, SessionListSnapshot, WorkspaceListSnapshot, WorkspaceViewLike } from '../types'
import { isEnglishLocale, text } from '../locales'

/** 按出现顺序合并多个 id 列表（去重；GET 载荷优先，快照补漏）。 */
export function unionIds(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const id of list) {
      if (seen.has(id))
        continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function workspaceTitleOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * 合并归档载荷与 session/workspace 运行时快照，生成带展示字段的归档行。
 */
export function buildRows(
  archivedSessionIds: string[],
  meta: Record<string, { createdAt?: number, cwd?: string, title?: string }>,
  sessions: SessionListSnapshot,
  workspaces: WorkspaceListSnapshot,
  titleById: Record<string, string>,
): ArchiveRow[] {
  const byPath = new Map<string, WorkspaceViewLike>()
  for (const ws of workspaces.items)
    byPath.set(ws.path, ws)

  const rows: ArchiveRow[] = []
  for (const sessionId of archivedSessionIds) {
    const summary = sessions.byId[sessionId]
    const entry = meta[sessionId]
    // The host archive set can briefly contain stale ids after a refresh; do not
    // render those ghosts, and never expose temporary blank sessions as archives.
    if (!summary && !entry)
      continue
    if (summary?.blank === true)
      continue
    let workspace = workspaces.items.find(ws => ws.sessionIds.includes(sessionId))
    const cwd = summary?.cwd ?? entry?.cwd
    if (!workspace && cwd)
      workspace = byPath.get(cwd)
    rows.push({
      sessionId,
      title: summary?.displayTitle ?? summary?.title ?? entry?.title ?? titleById[sessionId] ?? (cwd ? workspaceTitleOf(cwd) : undefined) ?? text('untitled'),
      cwd,
      createdAt: entry?.createdAt,
      updatedAt: summary?.updatedAt,
      workspaceId: workspace?.workspaceId,
      workspaceTitle: workspace?.title ?? (workspace ? workspaceTitleOf(workspace.path) : undefined),
    })
  }
  return rows
}

/** 项目下拉选项：从归档行收集「工作区 id → 标题」映射（保持出现顺序）。 */
export function projectOptions(rows: ArchiveRow[]): Map<string, string> {
  const options = new Map<string, string>()
  for (const row of rows) {
    if (row.workspaceId)
      options.set(row.workspaceId, row.workspaceTitle ?? row.workspaceId)
  }
  return options
}

/** 行时间展示（zh/en 双语格式）。 */
export function formatTime(row: ArchiveRow): string {
  const value = row.updatedAt ?? row.createdAt
  if (!value)
    return ''
  const d = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (isEnglishLocale()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
