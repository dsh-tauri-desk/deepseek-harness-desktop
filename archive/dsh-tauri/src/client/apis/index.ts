/**
 * apis/index.ts — 客户端 RPC/HTTP 层：全局 fetch（ofetch 统一 JSON 客户端）。
 *
 * 唯一导出 `fetch`：ofetch 负责 URL 拼接、JSON 解析（parseResponse 优先解码，
 * 旧宿主/未注册路由返回的纯文本错误体原样保留）、超时（timeout 选项）与
 * 重试（默认关）。错误归一（非 2xx → 可展示 Error，取响应体 error 字段）内置
 * 在此，调用方无需关心错误格式、无需自封装 requestJson/createJsonClient。
 */

import { createFetch } from 'ofetch'

/** JSON 响应优先解码；非 JSON 纯文本错误体保留原文。 */
function parseJsonResponse(text: string): unknown {
  if (text.length === 0)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/** 非 2xx 默认错误信息：优先取响应体 error 字段，否则回退状态码文案。 */
function defaultErrorMessage(status: number, body: unknown): string {
  const text = typeof body === 'string'
    ? body
    : body && typeof body === 'object' && 'error' in body
      ? String((body as { error?: unknown }).error ?? '')
      : ''
  return text ? `请求失败 (${status}): ${text}` : `请求失败 (${status})`
}

/** 全局 JSON fetch：同源 API 请求唯一入口（错误解析统一在此）。 */
export const fetch = createFetch({
  defaults: {
    retry: 0,
    parseResponse: parseJsonResponse,
    onResponseError: ({ response }) => {
      throw new Error(defaultErrorMessage(response.status, response._data))
    },
  },
})
