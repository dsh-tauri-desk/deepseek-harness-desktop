/**
 * 官方 controller 客户端类型统一出口。
 * 【来源】@deepseek-ai/dsh-api-session-controller/client 与
 * @deepseek-ai/dsh-api-workspace-controller/client。
 * 【版本】当前 lockfile 解析版本 0.1.2-alpha.3。
 * 【修订】2026-01：删除重复快照接口；startSession 仅保留为兼容扩展。
 */
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceSnapshot, WorkspaceSource, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { WorkspaceId as WorkspaceIdType } from './json'

export type { ISessions, IWorkspaces, SessionListState, SessionSummary, SlotRegistry, WorkspaceSnapshot, WorkspaceSource, WorkspaceView }
export type SessionsRuntime = ISessions
export type WorkspacesRuntime = IWorkspaces & { startSession?: (workspaceId?: WorkspaceIdType) => void }

/**
 * workspace 共享的宽松运行时面（ctx.sessions / ctx.workspaces 投影）。
 * 消费插件（dsh-tauri-session / dsh-tauri-rightclick / dsh-tauri-pet）统一从
 * `dsh-tauri/client` 引用，不再各自声明重复面，也不重复 `as unknown as` 断言
 * （断言目标统一为此处类型）。未知成员用宽松签名，需要官方精确面时用上面的
 * SessionsRuntime / WorkspacesRuntime Pick。
 */

/** 会话列表快照（list.subscribe/getSnapshot 投影）。 */
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

/** Minimal `ctx.sessions` face the plugins subscribe to. */
export interface SessionsRuntimeLike {
  list: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => SessionListSnapshot
  }
  /** Rebuild the in-memory session list after deleting persisted sessions. */
  refresh?: () => Promise<void>
  open?: (sessionId: string) => unknown
  binding?: (sessionId: string) => unknown
  fork?: (...args: unknown[]) => unknown
}

/** 工作区视图快照（list 投影）。 */
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

/** Minimal `ctx.workspaces` face the plugins subscribe to. */
export interface WorkspacesRuntimeLike {
  list: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => WorkspaceListSnapshot
  }
  /** Wire-truth owner behind the `list` projection. */
  manager?: {
    refresh?: () => Promise<void>
  }
  archiveSession?: (...args: unknown[]) => unknown
  delete?: (...args: unknown[]) => unknown
  startSession?: (workspaceId: string) => unknown
}

/**
 * 「打开文件夹」所需的官方工作区能力（Alpha / rc.2 通用面）。
 *
 * 三个动作与官方「添加工作区」流程（ui-workspace `WorkspacePickFlow.adoptDirectory`）
 * 逐步一致：`pickDirectory()` → `create({ path })` → `startSession(workspaceId)`；
 * 任一步缺失即视为能力不可用，由消费方走 DOM 退级（点官方按钮）。
 */
export interface AddWorkspaceRuntime {
  /** `uiWorkspace.pickDirectory()`：拉起宿主原生目录选择器；用户取消时为 null。 */
  pickDirectory: () => Promise<string | null | undefined>
  /** `workspaces.create({ path })`：登记工作区并返回其 id。 */
  createWorkspace: (input: { path: string }) => Promise<{ workspaceId: string }>
  /** `uiWorkspace.startSession(workspaceId)`：在目标工作区开一个新会话并打开。 */
  startSession: (workspaceId: string) => unknown
}
