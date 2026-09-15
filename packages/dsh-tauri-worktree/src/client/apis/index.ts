import type * as Types from './index.type'
import { fetch } from 'dsh-tauri/client'
import { WORKTREE_API_PREFIX } from '../../shared/constants'

export const baseURL = WORKTREE_API_PREFIX

export function getBindings(): Promise<Types.WorktreeBindings> {
  return fetch(`${baseURL}/bindings`)
}

export function getStatus(query: Types.GetStatusQuery): Promise<Types.WorktreeStatus> {
  const jobId = query.jobId ? `&jobId=${encodeURIComponent(query.jobId)}` : ''
  return fetch(`${baseURL}/status?sessionId=${encodeURIComponent(query.sessionId)}${jobId}`)
}

export function postCreate(body: Types.PostCreateBody): Promise<Types.WorktreeCreate> {
  return fetch(baseURL, { method: 'POST', body })
}

export function postAttach(body: Types.PostAttachBody): Promise<{ ok: boolean, workspaceId: string }> {
  return fetch(`${baseURL}/attach`, { method: 'POST', body })
}

export function postCheckout(body: Types.PostCheckoutBody): Promise<Types.WorktreeCheckout> {
  return fetch(`${baseURL}/checkout`, { method: 'POST', body })
}

export function deleteDiscard(body: Types.PostDiscardBody): Promise<Types.WorktreeDiscard> {
  return fetch(baseURL, { method: 'DELETE', body })
}
