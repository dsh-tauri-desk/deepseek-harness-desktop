/**
 * client/types/runtime.ts — 工作树客户端协议与官方 controller 类型。
 *
 * 【来源】官方 `dsh-tauri/client` 的 `ISessions`、`IWorkspaces`、
 * `SessionListState`、`WorkspaceSnapshot`、`WorkspaceView`。
 * 【版本】@deepseek-ai/dsh-api-session-controller@0.1.2-alpha.3；
 * @deepseek-ai/dsh-api-workspace-controller@0.1.2-alpha.3。
 * 【修订】2026-01：官方 branded id 在 DOM/HTTP 字符串边界通过本地 adapter 投影，
 * 删除原先把官方服务重新手写成无来源运行时接口的做法。
 */

import type { SessionListState } from 'dsh-tauri/client'

export type { SessionListState }

/** Stable local projection used at the worktree's string-id boundary. */
export interface WorkspaceView {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
}

export interface WorkspaceSnapshot {
  items: readonly WorkspaceView[]
}

/**
 * 输入条草稿状态。字段名跨核心版本不一致，两个都声明为可选：
 *   - rc.x 及更早：`imageIds`
 *   - 0.1.5-alpha.1 起：`attachmentIds`
 * 消费方必须经 `utils/draft-attachments.ts` 的兼容读取函数访问，不能直接取单一字段。
 */
export interface InputState {
  draft: string
  imageIds?: string[]
  attachmentIds?: string[]
}

/** 输入条动作面；同样按核心版本二选一（rc.x 的 addImages/removeImage ↔ alpha 的 addAttachments/removeAttachment）。 */
export interface InputActions {
  setDraft: (text: string) => void
  addImages?: (ids: string[]) => boolean
  removeImage?: (id: string) => void
  addAttachments?: (ids: string[]) => boolean
  removeAttachment?: (id: string) => void
  submit: () => void
}

/** 工作树 DOM/槽位 adapter：内部把字符串 id 转换到官方 branded controller。 */
export interface SessionsRuntime {
  create: (opts: { cwd: string, sessionId: string }) => Promise<string>
  open: (sessionId: string) => void
  provideInfo: (sessionId: string) => { props?: { inputActions?: InputActions } } | undefined
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

/** 官方 WorkspaceView 的工作树消费投影；id 在 adapter 边界保持字符串。 */
export interface WorkspaceSessionOrder {
  workspaceId: string
  path: string
  sessionIds: readonly string[]
}

/** 工作树调用的官方 Workspace controller adapter。 */
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

/** 官方 SessionListState 的工作树 adapter 子集。 */
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

/**
 * 被绑定的 Session 源（官方 `ClientSessions.binding(id).session`）。
 *
 * `getSnapshot` 是私有 Session 的 uSES 快照，含 `running` 回合位：hydration 只在
 * 「回合结束」（running true → false 边沿）复核一次工作树状态，而不是逐事件复核。
 * 该快照在核心版本间不保证存在，缺失时退回「自身事件驱动 + 节流」。
 */
export interface BoundSessionSource {
  subscribe?: (listener: () => void) => () => void
  getSnapshot?: () => { running?: boolean } | undefined
}

export interface WorktreeHydrationSessionsRuntime {
  binding: (sessionId: string) => { session?: BoundSessionSource } | undefined
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
