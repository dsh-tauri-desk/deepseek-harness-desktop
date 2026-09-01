/**
 * apis/client.ts — 工作树 API 客户端（ofetch 统一封装）。
 *
 * 与宿主侧 host/routes/ 的五个路由一一对应；所有类型（WorktreeStatus/Create/
 * Checkout）集中在本插件 client/types/。
 */

import type { WorktreeCheckout, WorktreeCreate, WorktreeStatus } from '../types'
import { createJsonClient } from 'dsh-tauri/client'
import { WORKTREE_API_PREFIX } from '../../shared/constants'

/** 绑定 API 前缀的 ofetch JSON 客户端。 */
export const worktreeApi = createJsonClient(WORKTREE_API_PREFIX)

/** 查询某会话的工作树状态（GET，sessionId 走查询串）。 */
export function fetchStatus(sessionId: string): Promise<WorktreeStatus> {
  return worktreeApi.request(`/status?sessionId=${encodeURIComponent(sessionId)}`)
}

/** 为预分配的新会话创建工作树；项目路径从当前源会话解析。 */
export function createWorktree(sessionId: string, sourceSessionId = sessionId): Promise<WorktreeCreate> {
  return worktreeApi.post('/create', { sessionId, sourceSessionId })
}

/** 将已创建的 worktree 会话正式归属到源项目 Workspace。 */
export function attachWorktreeSession(sessionId: string): Promise<{ ok: boolean, workspaceId: string }> {
  return worktreeApi.post('/attach', { sessionId })
}

/** 检出本地（弹窗确认后调用；分支名客户端已 trimmed）。 */
export function checkoutWorktree(
  sessionId: string,
  worktreeHashDirname: string,
  branchName: string,
): Promise<WorktreeCheckout> {
  return worktreeApi.post('/checkout', { sessionId, worktreeHashDirname, branchName })
}

/** 放弃更改：删除工作树并解除绑定，会话保留。 */
export function discardWorktree(
  sessionId: string,
  worktreeHashDirname: string,
): Promise<{ ok: boolean }> {
  return worktreeApi.post('/discard', { sessionId, worktreeHashDirname })
}
