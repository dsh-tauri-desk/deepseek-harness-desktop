/** types/runtime.ts — 宿主运行时快照类型（ctx.sessions / ctx.workspaces 投影）。 */

/** Minimal `ctx.sessions` face the archive page subscribes to. */
export interface SessionsRuntimeLike {
  list: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => SessionListSnapshot
  }
  /** Rebuild the in-memory session list after deleting persisted sessions. */
  refresh?: () => Promise<void>
}

export interface SessionSummaryLike {
  id: string
  title?: string
  displayTitle?: string
  cwd?: string
  updatedAt?: number
  blank?: boolean
  /** Session provenance; official sidebar hides subagent sessions. */
  origin?: string
}

export interface SessionListSnapshot {
  ids: string[]
  byId: Record<string, SessionSummaryLike>
  current?: string
  phase?: 'pending' | 'ready'
}

/** Minimal `ctx.workspaces` face the archive page subscribes to. */
export interface WorkspacesRuntimeLike {
  list: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => WorkspaceListSnapshot
  }
  /**
   * Wire-truth owner behind the `list` projection. The plugin's unarchive/
   * delete/clear mutations bypass the official unary actions (no changed
   * frames are emitted), so callers re-sync the archive mirror via `refresh`.
   */
  manager?: {
    refresh?: () => Promise<void>
  }
}

export interface WorkspaceViewLike {
  workspaceId: string
  path: string
  title?: string
  sessionIds: string[]
}

export interface WorkspaceListSnapshot {
  items: readonly WorkspaceViewLike[]
  archivedSessionIds?: readonly string[]
}
