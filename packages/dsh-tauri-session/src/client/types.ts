/** Client-side shared types for dsh-tauri-session. */

/** Raw archive listing from the host (`GET /api/dsh-session/archived`). */
export interface ArchivedListPayload {
  archivedSessionIds: string[]
  /** Per archived session, creation metadata read from the host session header. */
  meta: Record<string, { createdAt?: number, cwd?: string, title?: string }>
}

/** One archived session row after merging host metadata + session/workspace runtime facts. */
export interface ArchiveRow {
  sessionId: string
  title: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
  archivedAt?: number
  /** Workspace group this session is displayed under; undefined means the 未分组 bucket. */
  workspaceId?: string
  workspaceTitle?: string
}

/** Sort method for the archive page filter (applies to both rows and groups). */
export type ArchiveSort = 'updatedAt' | 'createdAt' | 'title'

/** Persistent archive-page UI state (shared via a module SnapshotStore). */
export interface ArchiveUiState {
  archived: ArchivedListPayload
  sort: ArchiveSort
  query: string
  /** Selected project/workspace filter; 'all' shows every group. */
  workspaceId: string
  loading: boolean
  /** A destructive/restore mutation is in flight (drives disabled + loading toast). */
  pending: boolean
  error: string
  /** IDs hidden optimistically after a successful restore/delete until host mirror catches up. */
  suppressedSessionIds: string[]
  /** Titles observed before a session disappears from the filtered session list. */
  titleById: Record<string, string>
}

/** Props injected into the settings.section slot component. */
export interface ArchivePanelProps {
  close?: () => void
  sessionsRuntime: SessionsRuntimeLike
  workspacesRuntime: WorkspacesRuntimeLike
}

/** Shared props for the local gravity-ui icon components. */
export interface IconProps {
  size?: number
  className?: string
}

/** One option of the official-style dropdown (primitives Menu select). */
export interface MenuSelectOption {
  id: string
  label: string
}

/** Props for the official-style `Menu`-based select trigger. */
export interface MenuSelectProps {
  /** Selected option id. */
  value: string
  /** Ordered options. */
  options: MenuSelectOption[]
  /** Called with the picked option id. */
  onSelect: (id: string) => void
  /** Accessible trigger name (aria-label). */
  label: string
}

/** Minimal `ctx.sessions` face the archive page subscribes to. */
export interface SessionsRuntimeLike {
  list: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => SessionListSnapshot
  }
  /** Open (navigate to) a session; used by the unarchive toast's 查看 action. */
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

export type LocaleKey
  = | 'section'
    | 'archiveTitle'
    | 'deleteAll'
    | 'searchPlaceholder'
    | 'sortLabel'
    | 'sortUpdatedAt'
    | 'sortCreatedAt'
    | 'sortTitle'
    | 'allProjects'
    | 'ungrouped'
    | 'unarchive'
    | 'empty'
    | 'noResults'
    | 'loadFailed'
    | 'chats'
    | 'groupMenuAria'
    | 'deleteProjectChats'
    | 'deleteProjectTitle'
    | 'deleteProjectBody'
    | 'archiveWorkspace'
    | 'archiveWorkspaceMenu'
    | 'archiveWorkspaceTitle'
    | 'archiveWorkspaceDescription'
    | 'archiveWorkspaceConfirm'
    | 'cancel'
    | 'deleteConfirm'
    | 'deleteRowAria'
    | 'deleteSingleTitle'
    | 'deleteSingleBody'
    | 'deleteAllTitle'
    | 'deleteAllBody'
    | 'loading'
    | 'unarchivedToast'
    | 'view'
    | 'untitled'
    | 'requestFailed'
    | 'requestTimeout'
