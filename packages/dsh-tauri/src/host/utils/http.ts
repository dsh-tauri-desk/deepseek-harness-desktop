/**
 * host/utils/http.ts — 宿主侧 HTTP 路由工具：连接鉴权包装、JSON 请求体读取、
 * JSON 响应发送与 routeHandler 方法/回环约束。
 *
 * 设计原因（与宿主侧 AGENTS.md 一致）：
 *   - routeHandler 严格限制方法（mutate=POST，否则 GET），变更操作必须本机回环
 *     （127.0.0.1）才放行；
 *   - 路由逻辑统一经 withConnectionAuth 做 DSH 连接信任边界校验；
 *   - 请求体超限即 413，解析失败 400，绝不静默接受。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionGate, JsonBody, RouteFunction, RouteHandler } from '../types/index.js'
import { Buffer } from 'node:buffer'

export type { ConnectionGate, JsonBody, RouteFunction, RouteHandler, RouteResult } from '../types/index.js'

export class HttpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'HttpError'
  }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** Apply DSH's browser trust and authentication boundary before route logic. */
export function withConnectionAuth(connection: ConnectionGate | undefined, handler: RouteHandler, _pluginName = 'dsh-tauri-plugin'): RouteHandler {
  if (typeof connection?.requestRejection !== 'function')
    return handler
  return async (request, response) => {
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    await handler(request, response)
  }
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function readJsonBody(request: IncomingMessage, limit = DEFAULT_MAX_BODY_BYTES): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let exceeded = false
    request.on('data', (chunk: Uint8Array | string) => {
      if (exceeded)
        return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > limit) {
        exceeded = true
        reject(new HttpError('请求体过大', 413))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (exceeded)
        return
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new HttpError('请求体必须是 JSON 对象', 400)
        resolve(parsed as JsonBody)
      }
      catch (error) {
        reject(error instanceof HttpError ? error : new HttpError('请求体不是有效的 JSON', 400))
      }
    })
    request.on('error', reject)
  })
}

export function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...JSON_HEADERS, ...headers })
  response.end(status === 204 ? undefined : JSON.stringify(payload))
}

export function routeHandler(fn: RouteFunction, { mutate = false }: { mutate?: boolean } = {}): RouteHandler {
  const allowedMethod = mutate ? 'POST' : 'GET'
  return async (request, response) => {
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {}, { allow: `${allowedMethod}, OPTIONS` })
      return
    }
    if (request.method !== allowedMethod) {
      sendJson(response, 405, { error: `仅支持 ${allowedMethod} 请求` }, { allow: `${allowedMethod}, OPTIONS` })
      return
    }
    if (mutate && !isLoopback(request)) {
      sendJson(response, 403, { error: '变更操作仅限本机（127.0.0.1）调用' })
      return
    }
    try {
      const [code, payload] = await fn(mutate ? await readJsonBody(request) : {}, request)
      sendJson(response, code, payload)
    }
    catch (error) {
      const code = error instanceof HttpError ? error.statusCode : 500
      sendJson(response, code, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function isSameOriginJsonRequest(request: IncomingMessage): { ok: true } | { ok: false, status: number, error: string } {
  const contentType = request.headers['content-type'] || ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType))
    return { ok: false, status: 415, error: 'unsupported-media-type' }
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin && host) {
    try {
      if (new URL(origin).host !== host)
        return { ok: false, status: 403, error: 'cross-origin-request' }
    }
    catch {
      return { ok: false, status: 403, error: 'cross-origin-request' }
    }
  }
  return { ok: true }
}

export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined)
    return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  }
  catch {
    return false
  }
}

export function respond(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  response.end(body)
}

export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}
