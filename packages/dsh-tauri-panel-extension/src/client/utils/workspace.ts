import type { ExtensionRuntimeContext, WorkspaceListItem } from '../types'

function workspaceId(item: WorkspaceListItem): string | undefined {
  return item.workspaceId ?? item.id
}

/** Follow DSH's New Session target order: current session, recent workspace, first workspace. */
export function chooseWorkspace(runtime: ExtensionRuntimeContext): string | undefined {
  const sessions = runtime.sessions.list.getSnapshot()
  const workspaces = runtime.workspaces.list.getSnapshot()
  const items = workspaces.items ?? []
  const currentItem = sessions.current === undefined
    ? undefined
    : items.find(item => item.sessionIds?.includes(sessions.current as string))
  const currentId = currentItem === undefined ? undefined : workspaceId(currentItem)
  if (currentId !== undefined)
    return currentId
  if (workspaces.recentWorkspaceId !== undefined && items.some(item => workspaceId(item) === workspaces.recentWorkspaceId))
    return workspaces.recentWorkspaceId
  return items.map(workspaceId).find((id): id is string => id !== undefined)
}
