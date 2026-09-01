/**
 * client/apis/client.ts — 归档管理 API 客户端（ofetch 统一封装）。
 *
 * 与宿主侧 host/routes/ 的七个路由一一对应；变更类请求统一 15s 超时
 * （宿主注册表状态机 + resync 语义见 store.ts）。函数名/签名与原 store.ts
 * 内联 RPC 完全一致，避免影响 panel.tsx 等消费者。
 */

import type { ArchivedListPayload } from '../types'
import { createJsonClient } from 'dsh-tauri/client'
import { SESSION_API_PREFIX } from '../../shared/constants'
import { text } from '../locales'

/** 绑定 API 前缀的 ofetch JSON 客户端（统一超时与本地化错误文案）。 */
export const sessionApi = createJsonClient(SESSION_API_PREFIX, {
  timeoutMs: 15_000,
  errorMessage: (status, body) => {
    const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : ''
    return error || text('requestFailed', { status })
  },
  timeoutMessage: text('requestTimeout'),
})

/** 查询归档会话列表。 */
export function fetchArchived(): Promise<ArchivedListPayload> {
  return sessionApi.request('/archived')
}

/** 归档单个会话。 */
export function postArchive(sessionId: string, workspaceId?: string, beforeSessionId?: string): Promise<ArchivedListPayload> {
  return sessionApi.post('/archive', { sessionId, ...(workspaceId ? { workspaceId } : {}), ...(beforeSessionId ? { beforeSessionId } : {}) })
}

/** 取消归档（会话回到其工作区组保留的位置）。 */
export function postUnarchive(sessionId: string): Promise<{ ok: boolean }> {
  return sessionApi.post('/unarchive', { sessionId })
}

/** 彻底删除一个归档会话（宿主移除 + 物理删除会话数据，不可恢复）。 */
export function postDelete(sessionId: string): Promise<{ ok: boolean }> {
  return sessionApi.post('/delete', { sessionId })
}

/** 归档整个工作区组（一次写入多条记录）。 */
export function postArchiveWorkspace(workspaceId: string, sessionIds: string[]): Promise<ArchivedListPayload> {
  return sessionApi.post('/archive-workspace', { workspaceId, sessionIds })
}

/** 清空归档（全部会话彻底删除，不可恢复）。 */
export function postClear(): Promise<{ ok: boolean }> {
  return sessionApi.post('/clear', {})
}

/** 删除项目内的全部归档会话。 */
export function postDeleteWorkspace(sessionIds: readonly string[]): Promise<{ ok: boolean }> {
  return sessionApi.post('/delete-workspace', { sessionIds })
}
