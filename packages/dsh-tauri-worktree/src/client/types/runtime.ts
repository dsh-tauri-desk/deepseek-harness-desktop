/** types/runtime.ts — 宿主运行时快照与槽位注入类型。 */

export interface InputState {
  draft: string
  imageIds: string[]
}

export interface InputActions {
  setDraft: (text: string) => void
  addImages: (ids: string[]) => boolean
  removeImage: (id: string) => void
  submit: () => void
}

export interface SessionsRuntime {
  create: (opts: { cwd: string, sessionId: string }) => Promise<string>
  open: (sessionId: string) => void
  provideInfo: (sessionId: string) => { props?: { inputActions?: InputActions } } | undefined
  /** 刷新会话列表（宿主侧 seed 创建的会话会发布进来；本插件在 waitForSessionListed 中调用）。 */
  refresh: () => Promise<void>
  list: { getSnapshot: () => { ids: string[], current?: string } }
}

export interface ModeSelectProps {
  sessionId: string
  useInput: <S>(selector: (state: InputState) => S) => S
  inputActions: InputActions
  sessionsRuntime: SessionsRuntime
  /** 归档源会话用：切换工作树成功后，删除被完整继承的源会话，避免侧边栏多出一个重复会话。 */
  workspacesRuntime: WorkspacesRuntime
}

export interface SurfaceBarProps {
  sessionId: string
}

export interface WorkspaceSessionOrder {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
}

export interface WorkspacesRuntime {
  archiveSession: (sessionId: string) => Promise<void>
  list: { getSnapshot: () => { items: WorkspaceSessionOrder[] } }
  insertSessionBefore: (workspaceId: string, sessionId: string, beforeSessionId?: string) => Promise<unknown>
}

export interface WorktreeDialogProps {
  useSessions: <S>(sel: (state: DialogListState) => S) => S
  sessionsRuntime: {
    open: (sessionId: string) => void
    refresh: () => Promise<void>
    list: { getSnapshot: () => { current?: string, ids: string[] } }
  }
  workspacesRuntime: WorkspacesRuntime
}

export interface DialogListState {
  phase: string
  current?: string
  byId: Record<string, unknown>
}

export interface SessionListSnapshot {
  ids: string[]
  current?: string
  phase?: 'pending' | 'ready'
}

export interface WorktreeHydrationSessionsRuntime {
  binding: (sessionId: string) => { session?: { subscribe?: (listener: () => void) => () => void } } | undefined
  list: {
    getSnapshot: () => SessionListSnapshot
    subscribe: (listener: () => void) => () => void
  }
  open: (sessionId: string) => void
  refresh: () => Promise<void>
}

export interface WorkspaceListSnapshot {
  archivedSessionIds: readonly string[]
}
