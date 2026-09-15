import type { ArchivePanelProps } from '../components/archive-panel.types'
import { uniq, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { buildRows, groupArchive } from '../components/archive-panel.utils'
import { locale } from '../locales'
import { store } from '../store'

/** 归档页的展示投影：订阅 store 与宿主运行时快照，派生行 / 分组 / 忙碌态。 */
export function useArchiveView(props: ArchivePanelProps) {
  const ui = useStore(store.archive)
  const sessions = useSyncExternalStore(props.sessionsRuntime.list.subscribe, props.sessionsRuntime.list.getSnapshot)
  const workspaces = useSyncExternalStore(props.workspacesRuntime.list.subscribe, props.workspacesRuntime.list.getSnapshot)

  // 列表 id 取「GET 载荷 ∪ 客户端工作区快照的 archivedSessionIds」——后者随宿主帧实时
  // 镜像官方「归档」动作，保证刚用官方菜单归档的会话立刻出现在本页。
  const archivedIds = uniq([...ui.archived.archivedSessionIds, ...(workspaces.archivedSessionIds ?? [])])
    .filter(id => !ui.suppressedSessionIds.includes(id))
  const rows = buildRows(archivedIds, ui.archived.meta, sessions, workspaces, ui.titleById)

  // 记录观测到的标题：会话从筛选列表消失后，幽灵行仍有可展示文案。
  useWatchImmediate([rows], () => {
    store.archive.mergeTitles(Object.fromEntries(rows.map(row => [row.sessionId, row.title] as const)))
  })

  const query = ui.query.trim().toLowerCase()
  const matched = query
    ? rows.filter(row =>
        row.title.toLowerCase().includes(query)
        || (row.cwd ?? '').toLowerCase().includes(query)
        || (row.workspaceTitle ?? '').toLowerCase().includes(query))
    : rows
  const visible = ui.workspaceId === 'all'
    ? matched
    : matched.filter(row => ui.workspaceId === 'ungrouped' ? !row.workspaceId : row.workspaceId === ui.workspaceId)

  return {
    ui,
    rows,
    visible,
    groups: groupArchive(visible, ui.sort, locale.text('ungrouped')),
    busy: ui.pending || ui.loading,
  }
}
