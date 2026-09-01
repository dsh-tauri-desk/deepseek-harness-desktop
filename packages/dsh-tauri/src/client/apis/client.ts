/**
 * client/http.ts — 基于 ofetch 的统一 JSON HTTP 客户端（全 workspace 客户端共享）。
 *
 * 替换各自手写的 fetch 封装：ofetch 负责 URL 拼接、JSON 解析、超时（timeout 选项）、
 * 重试（默认关）与错误归一；本模块只保留领域语义——非 2xx 抛「可展示」Error、
 * 按插件需要配置 timeoutMs/错误信息。
 */

import { createFetch } from 'ofetch'

/** 每个 JSON 请求的可选领域语义。 */
export interface JsonRequestOptions {
  /** 超时（毫秒）；未设置时无超时（沿用 ofetch 默认）。 */
  timeoutMs?: number
  /** 非 2xx 时的自定义错误信息；默认取响应体 error 字段。 */
  errorMessage?: (status: number, body: unknown) => string
  /** 超时错误信息。 */
  timeoutMessage?: string
}

function defaultErrorMessage(status: number, body: unknown): string {
  const text = body && typeof body === 'object' && 'error' in body
    ? String((body as { error?: unknown }).error ?? '')
    : ''
  return text ? `请求失败 (${status}): ${text}` : `请求失败 (${status})`
}

function withJsonContentType(headersInit: HeadersInit | undefined, body: unknown): Headers {
  const headers = new Headers(headersInit)
  // 与旧实现保持一致：仅在携带 body 时补 content-type，GET 不加。
  if (!headers.has('content-type') && body !== undefined)
    headers.set('content-type', 'application/json')
  return headers
}

/** 模块级 ofetch 实例（关闭自动重试；重试策略由各插件显式决定）。 */
const jsonFetch = createFetch({ defaults: { retry: 0 } })

/**
 * 发起同源 JSON 请求并返回解析后的响应体。
 * 非 2xx 抛 Error（默认含响应体 error 文本）；超时抛 timeoutMessage。
 * @param baseUrl API 前缀（如 /api/dsh-worktree）
 * @param path 路由路径（如 /status）
 * @param init 原生 fetch 选项（body 传 JSON.stringify 后的字符串）
 * @param options 领域语义（超时 / 错误信息）
 */
export async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  options: JsonRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs
  const timeoutEnabled = timeoutMs !== undefined && timeoutMs > 0
  try {
    return await jsonFetch<T>(`${baseUrl}${path}`, {
      ...init,
      headers: withJsonContentType(init.headers, init.body),
      ...(timeoutEnabled ? { timeout: timeoutMs } : {}),
      parseResponse: text => (text.length > 0 ? JSON.parse(text) : undefined),
      onResponseError: ({ response }) => {
        throw new Error((options.errorMessage ?? defaultErrorMessage)(response.status, response._data))
      },
    })
  }
  catch (error) {
    if (timeoutEnabled && error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      throw new Error(options.timeoutMessage ?? '请求超时')
    throw error
  }
}

/** 创建绑定一个 API 前缀的小型 JSON 客户端（插件 client/rpc 的共享底座）。 */
export function createJsonClient(baseUrl: string, options: JsonRequestOptions = {}) {
  return {
    request: <T>(path: string, init?: RequestInit): Promise<T> => requestJson<T>(baseUrl, path, init, options),
    post: <T>(path: string, body: unknown): Promise<T> => requestJson<T>(baseUrl, path, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options),
  }
}
