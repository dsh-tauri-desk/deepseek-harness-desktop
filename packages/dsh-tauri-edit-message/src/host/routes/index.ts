/**
 * host/routes/index.ts — 宿主 HTTP 路由（一条 exact 路由，按方法派发）。
 *
 *    GET  /message-tree?sessionId=<id>   整棵版本树（‹ n/m › 与版本图的数据面）
 *    POST /message-tree                  edit / retry / activate
 *
 * 上游把方法判断放在自己的 handleRoute 里；这里换成 dsh-tauri 的公开工具
 * （`readJsonBody` / `respond` / `isSameOriginJsonRequest` / `withConnectionAuth`），
 * 因为内核 webServer 的 exact 表按路径唯一（重复注册抛
 * `webserver: duplicate exact route`），而 `routeHandler` 一次只允许一个方法。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext, JsonBody } from '../types'
import {
  HttpError,
  isSameOriginJsonRequest,
  readJsonBody,
  respond,
  withConnectionAuth,
} from 'dsh-tauri'
import { EDIT_MESSAGE_PLUGIN_NAME, MESSAGE_TREE_PATH } from '../../shared/constants'
import { applyOperation, readTree } from '../service/edit-session'

/** 只允许本机（回环）地址发起变更。 */
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 构建路由列表（调用方负责 ctx.webServer.register 并在卸载时释放）。 */
export function buildRoutes(ctx: HostContext): any[] {
  // 连接信任边界是可选能力，且**不能**用 `ctx.connection` 取：宿主 fiber 未声明
  // inject 时 cordis 代理会抛 `cannot get property "connection" without inject`。
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET'
    if (method === 'OPTIONS') {
      respond(response, 204, {})
      return
    }
    if (method !== 'GET' && method !== 'POST') {
      respond(response, 405, { error: '仅支持 GET / POST 请求' })
      return
    }
    try {
      if (method === 'GET') {
        const url = new URL(request.url ?? MESSAGE_TREE_PATH, 'http://message-tree.local')
        respond(response, 200, await readTree(ctx, url.searchParams.get('sessionId') ?? ''))
        return
      }
      if (!isLoopback(request))
        throw new HttpError('变更操作仅限本机（127.0.0.1）调用', 403)
      const sameOrigin = isSameOriginJsonRequest(request)
      if (!sameOrigin.ok) {
        respond(response, sameOrigin.status, { error: sameOrigin.error })
        return
      }
      const body: JsonBody = await readJsonBody(request)
      respond(response, 200, await applyOperation(ctx, body as Record<string, unknown>))
    }
    catch (error) {
      // 与上游一致：TypeError 是调用方错误（400），其余是运行时故障（409）。
      const code = error instanceof HttpError
        ? error.statusCode
        : error instanceof TypeError ? 400 : 409
      respond(response, code, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return [
    { kind: 'exact', path: MESSAGE_TREE_PATH, handler: withConnectionAuth(connection, handler, EDIT_MESSAGE_PLUGIN_NAME) },
  ]
}
