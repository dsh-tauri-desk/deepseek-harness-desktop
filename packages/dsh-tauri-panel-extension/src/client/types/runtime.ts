/** types/runtime.ts — 宿主运行时快照与桌面桥类型。 */

export interface InputActions {
  setDraft: (text: string) => void
}

export interface ConversationInputLeftProps {
  sessionId: string
  inputActions: InputActions
}

export interface SessionListSnapshot {
  current?: string
  ids: string[]
}

export interface WorkspaceListItem {
  workspaceId?: string
  id?: string
  sessionIds?: readonly string[]
  updatedAt?: number | string
}

export interface WorkspaceListSnapshot {
  items?: WorkspaceListItem[]
  recentWorkspaceId?: string
}

export interface DesktopBridge {
  restartSidecar?: () => void
}

declare global {
  interface Window {
    dshDesktop?: DesktopBridge
  }
}

export interface ExtensionRuntimeContext {
  sessions: {
    list: { getSnapshot: () => SessionListSnapshot }
    open: (sessionId: string) => void
  }
  workspaces: {
    list: { getSnapshot: () => WorkspaceListSnapshot }
    connectWorkspace: (workspaceId: string) => Promise<string>
  }
}
