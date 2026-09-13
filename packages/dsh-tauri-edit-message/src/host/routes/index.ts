/**
 * host/routes/index.ts — 宿主 HTTP 路由（一条 exact 路由，按方法派发）。
 *
 *    GET  /message-tree?sessionId=<id>   整棵版本树（‹ n/m › 与版本图的数据面）
 *    POST /message-tree                  { sessionId, turn | eventSeq, text }
 *                                        -> { ok, boundary, turn, eventSeq, before }
 *
 * 与 DSH-EasyRewrite 一致：POST 只**解析边界**（该消息之前最后一个闭合回合的
 * turn/end seq），fork 由客户端用官方 RPC 执行——宿主半区不碰 Agent，因此源会话
 * 不会被重新激活、也不会被重跑。
 *
 * 内核 webServer 的 exact 表按路径唯一（重复注册抛 `webserver: duplicate exact
 * route`），而 `routeHandler` 一次只允许一个方法，所以这里自行按方法派发；方法限制、
 * 回环校验、JSON 体读取与错误归一仍全部走 `dsh-tauri` 的公开工具。
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
import { planEdit, readTree } from '../service/edit-session'

/** 只允许本机（回环）地址发起变更。 */
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 非空字符串校验。 */
function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('sessionId 必须是非空字符串。')
  return value
}

/** 非负安全整数校验。 */
function integerOf(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} 必须是非负安全整数。`)
  return value as number
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
        respond(response, 200, await readTree(ctx, sessionIdOf(url.searchParams.get('sessionId'))))
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
      const sessionId = sessionIdOf(body.sessionId)
      if (typeof body.text !== 'string' || body.text.trim().length === 0)
        throw new TypeError('text 必须是非空字符串。')
      // 定位轮次的两条路径：DOM 注入只读得到 turn，气泡 props 带 eventSeq。
      const hasTurn = Number.isSafeInteger(body.turn) && (body.turn as number) >= 0
      const hasEventSeq = Number.isSafeInteger(body.eventSeq) && (body.eventSeq as number) >= 0
      if (!hasTurn && !hasEventSeq)
        throw new TypeError('必须提供 turn 或 eventSeq 来定位被编辑的消息。')
      const eventSeq = hasEventSeq ? integerOf(body.eventSeq, 'eventSeq') : undefined
      const turn = hasTurn ? integerOf(body.turn, 'turn') : undefined
      const result = await planEdit(ctx, sessionId, turn, eventSeq)
      respond(response, result.ok ? 200 : result.code === 'turn-open' || result.code === 'no-boundary' ? 409 : 404, result)
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
