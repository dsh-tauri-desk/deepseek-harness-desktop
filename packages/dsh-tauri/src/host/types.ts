/**
 * host/types.ts — dsh-tauri 宿主侧共享类型（HTTP 路由契约）。
 * 插件宿主模块（worktree/session/panel-extension 等）经 `dsh-tauri` 导入使用。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export type JsonBody = Record<string, unknown>
export type RouteResult = [number, unknown]
export type RouteFunction = (body: JsonBody, req: IncomingMessage) => Promise<RouteResult>
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

/** DSH Connection 的浏览器信任与鉴权边界（路由注册时包装用）。 */
export interface ConnectionGate {
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined
}
