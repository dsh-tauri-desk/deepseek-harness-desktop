/** Client-side shared types for dsh-tauri-rightclick. */

/** 会话列表摘要（最小 `ctx.sessions.list` 快照面）。 */
export interface SessionSummaryLike {
  id: string
  title?: string
  displayTitle?: string
  cwd?: string
  blank?: boolean
}

export interface SessionListSnapshotLike {
  ids: string[]
  byId: Record<string, SessionSummaryLike>
  current?: string
}

/** 会话绑定（`ctx.sessions.binding` 返回面的最小子集）。 */
export interface SessionBindingLike {
  session: {
    rename: (title: string) => Promise<{ ok: boolean, error?: { message?: string } }>
  }
}

/** 最小 `ctx.sessions` 面（客户端用到的子集）。 */
export interface SessionsRuntimeLike {
  list: {
    getSnapshot: () => SessionListSnapshotLike
  }
  binding: (sessionId: string) => SessionBindingLike | undefined
  fork: (opts: { sessionId: string, increaseTitle?: boolean }) => Promise<string>
  open: (sessionId: string) => void
}

/** 工作区视图（`ctx.workspaces.list` 快照项）。 */
export interface WorkspaceViewLike {
  workspaceId: string
  title: string
  path: string
  sessionIds: string[]
}

export interface WorkspaceListSnapshotLike {
  items: WorkspaceViewLike[]
  archivedSessionIds: string[]
}

/** 最小 `ctx.workspaces` 面（客户端用到的子集）。 */
export interface WorkspacesRuntimeLike {
  list: {
    getSnapshot: () => WorkspaceListSnapshotLike
  }
  archiveSession: (sessionId: string) => Promise<void>
  startSession: (workspaceId: string) => void
  delete: (workspaceId: string) => Promise<void>
}

/** 右键菜单扩展协议：其他 Web 插件登记到全局注册表的一条扩展项。 */
export interface ContextMenuExtension {
  id: string
  order?: number
  label?: string
  /** 按会话决定是否显示（缺省显示）。 */
  visible?: (context: { session?: SessionSummaryLike | null, row: Element | null }) => boolean
  /** 点击菜单项时执行。 */
  run: (context: {
    session?: SessionSummaryLike | null
    row: Element | null
    sessions: SessionsRuntimeLike
    workspaces: WorkspacesRuntimeLike
    close: () => void
  }) => void | Promise<void>
}

/** `dsh:rightclick-menu` 事件 detail（每次打开菜单时派发）。 */
export interface ContextMenuEventDetail {
  row: Element | null
  /** 官方会话操作按钮（存在时）。 */
  action: HTMLElement | null
  session: SessionSummaryLike | null
  workspace: WorkspaceViewLike | null
  target: EventTarget | null
  x: number
  y: number
  extensions: ContextMenuExtension[]
}

/** 本插件文案键（zh 字典键集合为权威）。 */
export type LocaleKey
  = | 'renameSession'
    | 'archiveSession'
    | 'openInExplorer'
    | 'copyWorkingDirectory'
    | 'copySessionId'
    | 'forkSession'
    | 'refresh'
    | 'newSession'
    | 'renameWorkspace'
    | 'copyWorkspacePath'
    | 'archiveWorkspaceSessions'
    | 'archiveUngroupedSessions'
    | 'undo'
    | 'redo'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'selectAll'
    | 'copySelectedText'
    | 'openInDefaultBrowser'
    | 'copyLink'
    | 'selectCurrentContent'
    | 'copiedWorkingDirectory'
    | 'copiedSessionId'
    | 'copiedWorkspacePath'
    | 'sessionRenamed'
    | 'sessionArchived'
    | 'copied'
    | 'cutDone'
    | 'linkCopied'
    | 'noWorkspaceSessions'
    | 'noUngroupedSessions'
    | 'archiveWorkspaceTitle'
    | 'archiveWorkspaceDescription'
    | 'archiveWorkspaceConfirmAction'
    | 'archiveUngroupedTitle'
    | 'archiveUngroupedDescription'
    | 'deleteWorkspace'
    | 'deleteWorkspaceTitle'
    | 'deleteWorkspaceDescription'
    | 'deleteWorkspaceConfirm'
    | 'workspaceDeleted'
    | 'cancel'
    | 'workspaceSessionsArchived'
    | 'officialSessionActionUnavailable'
    | 'officialWorkspaceActionUnavailable'
    | 'openFailed'
    | 'unknownError'
    | 'clipboardUnavailable'
    | 'clipboardReadFailed'
    | 'useUndoShortcut'
    | 'useRedoShortcut'
    | 'invalidLink'
    | 'officialRenameUnavailable'
    | 'officialWorkspaceRenameUnavailable'
    | 'officialArchiveUnavailable'
    | 'officialForkUnavailable'
    | 'sessionUnknown'
    | 'sessionNameEmpty'
    | 'sessionServiceUnavailable'
    | 'renameFailed'
    | 'editPositionUnknown'
