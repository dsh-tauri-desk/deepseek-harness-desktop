/**
 * client/apis/index.ts — 调用宿主 /message-tree 与会话归档/删除路由。
 *
 * 统一用 `dsh-tauri/client` 的 ofetch `fetch`：URL 拼接、JSON 解析与非 2xx 的错误
 * 归一（优先响应体 error 字段）都已内置，调用方不再手写状态码判断。
 */

import type { EditRequest, EditResponse } from '../types'
import { fetch } from 'dsh-tauri/client'
import { MESSAGE_TREE_PATH, SESSION_API_PREFIX } from '../constants'

/** @method post 解析编辑边界（宿主只读，fork 由客户端执行）。 */
export function postEdit(body: EditRequest): Promise<EditResponse> {
  return fetch<EditResponse>(MESSAGE_TREE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** @method post 归档一条会话（dsh-tauri-session 提供；官方可逆操作）。 */
export function postArchive(sessionId: string): Promise<unknown> {
  return fetch(`${SESSION_API_PREFIX}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

/**
 * @method post 彻底删除一条**已归档**会话（宿主移除 + 物理删除会话数据，不可恢复）。
 *
 * 由内置插件 dsh-tauri-session 提供，内置两步校验：非归档成员会被拒绝，所以调用前
 * 必须先 `postArchive`。
 */
export function postDelete(sessionId: string): Promise<unknown> {
  return fetch(`${SESSION_API_PREFIX}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}
