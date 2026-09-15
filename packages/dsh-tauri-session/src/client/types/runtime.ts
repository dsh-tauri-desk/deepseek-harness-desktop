import type {
  ISessions,
  IWorkspaces,
  SessionListState,
  SessionSummary,
  WorkspaceId,
  WorkspaceSnapshot,
  WorkspaceView,
} from 'dsh-tauri/client'

export type SessionSummaryLike = SessionSummary
export type WorkspaceViewLike = WorkspaceView

/** 会话列表快照投影（`sessions.list.getSnapshot()`，branded id 放宽为裸字符串）。 */
export type SessionListSnapshot = Omit<SessionListState, 'ids' | 'byId' | 'current'> & {
  ids: string[]
  byId: Record<string, SessionSummary>
  current?: string
}

/** 工作区快照投影（`workspaces.list.getSnapshot()`）。 */
export type WorkspaceListSnapshot = Pick<WorkspaceSnapshot, 'items' | 'archivedSessionIds'>

/** 官方 sessions 服务面：列表订阅 + 刷新 + 打开 + 绑定 + fork。 */
export type SessionsRuntimeLike = Pick<ISessions, 'list' | 'refresh' | 'open' | 'binding' | 'fork'>

/** 官方 workspaces 服务面 + 桌面导航扩展（`manager` / `startSession` 为跨核心版本兼容扩展）。 */
export type WorkspacesRuntimeLike = Pick<IWorkspaces, 'list' | 'archiveSession' | 'delete'> & {
  manager?: { refresh?: () => Promise<void> }
  startSession?: (workspaceId: WorkspaceId) => void
}
