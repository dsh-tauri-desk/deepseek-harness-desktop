export interface InputState {
  draft: string
  imageIds?: string[]
  attachmentIds?: string[]
}

export interface InputActions {
  setDraft: (text: string) => void
  addImages?: (ids: string[]) => boolean
  removeImage?: (id: string) => void
  addAttachments?: (ids: string[]) => boolean
  removeAttachment?: (id: string) => void
  submit: () => void
}

export interface SessionsRuntime {
  create: (opts: { cwd: string, sessionId: string }) => Promise<string>
  open: (sessionId: string) => void
  provideInfo: (sessionId: string) => { props?: { inputActions?: InputActions } } | undefined
  refresh: () => Promise<void>
  list: { getSnapshot: () => { ids: string[], current?: string } }
}

export interface WorkspacesRuntime {
  archiveSession: (sessionId: string) => Promise<void>
  list: { getSnapshot: () => { items: WorkspaceSessionOrder[] } }
  insertSessionBefore: (workspaceId: string, sessionId: string, beforeSessionId?: string) => Promise<unknown>
}

export interface WorkspaceSessionOrder {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
}

export type Wait = (ms: number) => Promise<void>

export type SwitchOutcome = 'switched' | 'aborted' | 'retry'

export interface ListSessions {
  refresh: () => Promise<void>
  list: { getSnapshot: () => { ids: string[] } }
}

export interface InputSessions extends ListSessions {
  provideInfo: (sessionId: string) => { props?: { inputActions?: InputActions } } | undefined
}

export interface SwitchSessions {
  open: (sessionId: string) => void
  refresh: () => Promise<void>
  list: { getSnapshot: () => { ids: string[], current?: string } }
}
