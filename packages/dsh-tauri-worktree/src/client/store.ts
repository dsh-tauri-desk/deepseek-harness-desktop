import type {
  WorktreeSessionState,
  WorktreeUiState,
} from './types'
import { createExternalStore, createLocalStorage } from 'dsh-tauri/client'
/**
 * store.ts — dsh-tauri-worktree 的共享客户端状态（per-session 工作树状态 + 偏好）。
 *
 * 桌面壳四个注册条目（select / surface / dialog / session）是同一
 * 插件的多个独立槽位，凭一个模块级 SnapshotStore 共享按会话缓存的工作树状态。
 * 任何条目把某会话的 state 写入 store，其余条目订阅渲染；所有后端调用集中在
 * rpc.ts（ofetch 客户端，/api/dsh-worktree/*），与宿主侧的 HTTP 路由一一对应。
 *
 * 新会话偏好（local/pending）经 dsh-tauri/client 的 createLocalStorage（unstorage
 * localStorage driver，base 拼 `base:` 前缀防串扰，兼容旧 key）持久化，apply 时
 * hydrate 一次缓存到模块级；写入即改即存。客户端依赖统一由 dsh-tauri 加载，本包
 * 不再直接 import unstorage。
 */
import { useSyncExternalStore } from 'react'
import { WORKTREE_PLUGIN_NAME } from '../shared/constants'
import { checkoutWorktree, discardWorktree } from './rpc'

/** 偏好存储（unstorage localStorage driver，base 由 driver 拼 `base:` 前缀防串扰，兼容旧 key）。 */
const prefsStorage = createLocalStorage(WORKTREE_PLUGIN_NAME)

const PREFERRED_MODE_KEY = 'preferred-mode'
/** 模块级偏好缓存；未被 hydrate 前保持官方默认「本地」。 */
let preferredMode: 'local' | 'pending' = 'local'
let prefsHydrated = false

/** apply 时调用一次：异步读回用户上次选择（失败保持默认）。 */
export async function hydratePreferredMode(): Promise<void> {
  if (prefsHydrated)
    return
  prefsHydrated = true
  try {
    preferredMode = (await prefsStorage.getItem(PREFERRED_MODE_KEY)) === 'pending' ? 'pending' : 'local'
  }
  catch {
    /* 存储不可用（隐私模式等）不影响会话功能 */
  }
}

/** 新会话沿用用户最近选择；存储不可用时保持官方默认「本地」。 */
export function preferredNewSessionMode(): 'local' | 'pending' {
  return preferredMode
}

export function rememberNewSessionMode(mode: 'local' | 'pending'): void {
  preferredMode = mode
  void prefsStorage.setItem(PREFERRED_MODE_KEY, mode).catch(() => {})
}

/** 从 unknown 错误里取可展示文本。 */
function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export {
  attachWorktreeSession,
  checkoutWorktree,
  createWorktree,
  discardWorktree,
  fetchStatus,
} from './rpc'

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

export type { WorktreePhase, WorktreeSessionState } from './types'

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
// 变更动作（rpc + store 合并语义）
// ---------------------------------------------------------------------------

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

export type { WorktreeCheckout, WorktreeCreate, WorktreeStatus, WorktreeUiState } from './types'
