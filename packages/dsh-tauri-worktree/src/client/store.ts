import type {
  WorktreeCheckout,
  WorktreeCreate,
  WorktreeSessionState,
  WorktreeStatus,
  WorktreeUiState,
} from './types'
import { createExternalStore } from 'dsh-tauri/client'
/**
 * store.ts — dsh-tauri-worktree 的共享客户端状态（per-session 工作树状态 + RPC）。
 *
 * 桌面壳四个注册条目（select / surface / dialog / session）是同一
 * 插件的多个独立槽位，凭一个模块级 SnapshotStore 共享按会话缓存的工作树状态。
 * 任何条目把某会话的 state 写入 store，其余条目订阅渲染；所有后端调用集中在
 * 本文件的 worktreeApi 里（/api/dsh-worktree/*），与宿主侧的 HTTP 路由一一对应。
 */
import { useSyncExternalStore } from 'react'
import { PREFERRED_MODE_STORAGE_KEY, WORKTREE_API_PREFIX } from './constants'

/** 新会话沿用用户最近选择；存储不可用时保持官方默认「本地」。 */
export function preferredNewSessionMode(): 'local' | 'pending' {
  try {
    return localStorage.getItem(PREFERRED_MODE_STORAGE_KEY) === 'pending' ? 'pending' : 'local'
  }
  catch {
    return 'local'
  }
}

export function rememberNewSessionMode(mode: 'local' | 'pending'): void {
  try {
    localStorage.setItem(PREFERRED_MODE_STORAGE_KEY, mode)
  }
  catch {
    // 隐私模式或受限存储不影响会话功能。
  }
}

/** 从 unknown 错误里取可展示文本。 */
function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { WorktreePhase, WorktreeSessionState } from './types'

/** 无绑定会话的初始状态。 */
export function blankState(): WorktreeSessionState {
  return {
    mode: preferredNewSessionMode(),
    // 未知 git 状态时默认按 git 仓库处理（工作树插件的目标用户），待 status 返回后校准。
    isGit: true,
    phase: 'idle',
    loadingLabel: '',
    log: [],
    worktreeKey: '',
    worktreePath: '',
    projectPath: '',
    sourceSessionId: '',
    branchName: 'dsh/',
    checkoutOpen: false,
    abandonOpen: false,
    error: '',
  }
}

/** useSyncExternalStore 的空 snapshot 必须保持引用稳定，否则会触发无限重渲染。 */
const EMPTY_STATE = blankState()

export type { WorktreeCheckout, WorktreeCreate, WorktreeStatus, WorktreeUiState } from './types'

export const worktreeStore = createExternalStore<WorktreeUiState>({
  bySession: {},
})

/** 取某会话的 state（无则回退空白态）。 */
export function selectSessionState(state: WorktreeUiState, sessionId: string | undefined): WorktreeSessionState {
  if (!sessionId)
    return EMPTY_STATE
  return state.bySession[sessionId] ?? EMPTY_STATE
}

/** 更新某会话的 state（merge 语义）。 */
export function patchSession(sessionId: string | undefined, patch: Partial<WorktreeSessionState>): void {
  if (!sessionId)
    return
  worktreeStore.set(state => ({
    ...state,
    bySession: {
      ...state.bySession,
      [sessionId]: { ...(state.bySession[sessionId] ?? blankState()), ...patch },
    },
  }))
}

/** 组件内订阅某会话的工作树状态（uSES）。 */
export function useWorktreeSession(sessionId: string | undefined): WorktreeSessionState {
  return useSyncExternalStore(
    worktreeStore.subscribe,
    () => selectSessionState(worktreeStore.getSnapshot(), sessionId),
  )
}

// ---------------------------------------------------------------------------
// RPC（/api/dsh-worktree/*，同源 fetch）
// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${WORKTREE_API_PREFIX}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`请求失败 (${res.status}): ${text}`)
  }
  return res.json() as Promise<T>
}

/** 查询某会话的工作树状态（GET，sessionId 走查询串）。 */
export function fetchStatus(sessionId: string): Promise<WorktreeStatus> {
  return request<WorktreeStatus>(`/status?sessionId=${encodeURIComponent(sessionId)}`)
}

/** 为预分配的新会话创建工作树；项目路径从当前源会话解析。 */
export function createWorktree(sessionId: string, sourceSessionId = sessionId): Promise<WorktreeCreate> {
  return request<WorktreeCreate>('/create', {
    method: 'POST',
    body: JSON.stringify({ sessionId, sourceSessionId }),
  })
}

/** 将已创建的 worktree 会话正式归属到源项目 Workspace。 */
export function attachWorktreeSession(sessionId: string): Promise<{ ok: boolean, workspaceId: string }> {
  return request('/attach', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export function checkoutWorktree(
  sessionId: string,
  worktreeHashDirname: string,
  branchName: string,
): Promise<WorktreeCheckout> {
  return request('/checkout', {
    method: 'POST',
    body: JSON.stringify({ sessionId, worktreeHashDirname, branchName }),
  })
}

/** 放弃更改：删除工作树并解除绑定，会话保留。 */
export function discardWorktree(
  sessionId: string,
  worktreeHashDirname: string,
): Promise<{ ok: boolean }> {
  return request('/discard', {
    method: 'POST',
    body: JSON.stringify({ sessionId, worktreeHashDirname }),
  })
}

/** 检出本地（弹窗确认后调用）。 */
export async function applyCheckout(
  sessionId: string,
  worktreeHashDirname: string,
  branchName: string,
): Promise<{ ok: boolean, error?: string, targetSessionId?: string }> {
  try {
    const result = await checkoutWorktree(sessionId, worktreeHashDirname, branchName)
    patchSession(sessionId, {
      mode: 'local',
      phase: 'idle',
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      checkoutOpen: false,
      error: '',
    })
    return { ok: true, targetSessionId: result.targetSessionId }
  }
  catch (error) {
    patchSession(sessionId, { error: errMessage(error) })
    return { ok: false, error: errMessage(error) }
  }
}

/** 放弃更改（弹窗确认后调用）。 */
export async function applyDiscard(
  sessionId: string,
  worktreeHashDirname: string,
): Promise<{ ok: boolean, error?: string }> {
  try {
    await discardWorktree(sessionId, worktreeHashDirname)
    patchSession(sessionId, {
      mode: 'local',
      phase: 'idle',
      loadingLabel: '',
      log: [],
      worktreeKey: '',
      abandonOpen: false,
      error: '',
    })
    return { ok: true }
  }
  catch (error) {
    patchSession(sessionId, { error: errMessage(error) })
    return { ok: false, error: errMessage(error) }
  }
}
