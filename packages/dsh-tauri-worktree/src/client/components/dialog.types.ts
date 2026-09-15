import type { WorkspacesRuntime } from '../service/session-switch.types'

export interface DialogListState {
  phase: string
  current?: string
  byId: Record<string, unknown>
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
