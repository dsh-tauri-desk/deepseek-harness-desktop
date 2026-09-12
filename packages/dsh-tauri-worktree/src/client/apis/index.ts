import type * as Types from './index.type'
import { fetch } from 'dsh-tauri/client'
import { WORKTREE_API_PREFIX } from '../../shared/constants'

export const baseURL = WORKTREE_API_PREFIX

/** @method get 批量查询全部工作树绑定与未收敛删除任务（hydration 的一次性入口）。 */
export function getBindings(): Promise<Types.WorktreeBindings> {
  return fetch(`${baseURL}/bindings`)
}

/** @method get 查询某会话的工作树状态。 */
export function getStatus(query: Types.GetStatusQuery): Promise<Types.WorktreeStatus> {
  const jobId = query.jobId ? `&jobId=${encodeURIComponent(query.jobId)}` : ''
  return fetch(`${baseURL}/status?sessionId=${encodeURIComponent(query.sessionId)}${jobId}`)
}

/** @method post 为预分配的新会话创建工作树。 */
export function postCreate(body: Types.PostCreateBody): Promise<Types.WorktreeCreate> {
  return fetch(`${baseURL}/create`, { method: 'POST', body })
}

/** @method post 将已创建的 worktree 会话归属到源项目 Workspace。 */
export function postAttach(body: Types.PostAttachBody): Promise<{ ok: boolean, workspaceId: string }> {
  return fetch(`${baseURL}/attach`, { method: 'POST', body })
}

/** @method post 检出本地（分支名客户端已 trimmed）。 */
export function postCheckout(body: Types.PostCheckoutBody): Promise<Types.WorktreeCheckout> {
  return fetch(`${baseURL}/checkout`, { method: 'POST', body })
}

/** @method post 放弃更改：删除工作树并解除绑定，会话保留。 */
export function postDiscard(body: Types.PostDiscardBody): Promise<Types.WorktreeDiscard> {
  return fetch(`${baseURL}/discard`, { method: 'POST', body })
}
