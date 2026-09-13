/**
 * client/apis/index.ts — 调用宿主 /message-tree。
 *
 * 统一用 `dsh-tauri/client` 的 ofetch `fetch`：URL 拼接、JSON 解析与非 2xx 的
 * 错误归一（优先响应体 error 字段）都已内置，调用方不再手写状态码判断。
 */

import type { EditRequest, EditResponse } from '../types'
import { fetch } from 'dsh-tauri/client'
import { MESSAGE_TREE_PATH } from '../constants'

/** @method get 读取一条会话所在家族的完整版本树。 */
export function getTree(sessionId: string): Promise<{ sessionId: string, versions: unknown[] }> {
  // no-store：版本树随时可能因编辑 / 删除变化，不能吃浏览器缓存（与上游一致）。
  return fetch(`${MESSAGE_TREE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
}

/** @method post 提交一次编辑（宿主从该轮之前重建会话并重新生成）。 */
export function postEdit(body: EditRequest): Promise<EditResponse> {
  return fetch<EditResponse>(MESSAGE_TREE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify(body),
  })
}
