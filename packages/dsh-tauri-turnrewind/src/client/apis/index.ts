/**
 * client/apis/index.ts — 客户端 HTTP 面（同源 fetch，唯一入口 dsh-tauri/client 的 fetch）。
 *
 * URL 与宿主资源路径逐段一致（`routes/session/<子资源>/<方法>.ts` ↔
 * `${baseURL}/session/<子资源>`），改任一侧必须同步另一侧。
 *
 * 撤销失败（409 冲突等）必须把响应体读出来展示，因此 undo 用 `fetch.raw` +
 * `ignoreResponseError`：自己判状态码，而不是让统一错误归一丢掉冲突清单。
 */

import type { LiveSnapshot, SessionSummary, UndoResponse } from '../types'
import type { PostUndoBody } from './index.type'
import { fetch } from 'dsh-tauri/client'
import { TURNREWIND_API_PREFIX } from '../../shared/constants'

export const baseURL = TURNREWIND_API_PREFIX

/** 读取某会话的 turn 变更摘要。 */
export function getSummary(sessionId: string): Promise<SessionSummary> {
  return fetch(`${baseURL}/session/summary?sessionId=${encodeURIComponent(sessionId)}`)
}

/** 读取某会话「运行中」的实时读数（宿主定时刷新的缓存值）。 */
export function getLive(sessionId: string): Promise<LiveSnapshot> {
  return fetch(`${baseURL}/session/live?sessionId=${encodeURIComponent(sessionId)}`)
}

/** 撤销某个 turn 的文件改动；返回状态码与响应体（含冲突清单）。 */
export async function postUndo(body: PostUndoBody): Promise<{ status: number, data: UndoResponse }> {
  const response = await fetch.raw<UndoResponse>(`${baseURL}/session/undo`, {
    method: 'POST',
    body,
    ignoreResponseError: true,
  })
  const data = (response._data ?? {}) as UndoResponse
  return { status: response.status, data }
}
