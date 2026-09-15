/** JSON 响应优先解码；非 JSON 纯文本错误体保留原文。 */
export function parseJsonResponse(text: string): unknown {
  if (text.length === 0)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/** 非 2xx 默认错误信息：优先取响应体 error / message / statusMessage，否则回退状态码文案。 */
export function defaultErrorMessage(status: number, body: unknown): string {
  const text = typeof body === 'string'
    ? body
    : body && typeof body === 'object'
      ? readErrorText(body as Record<string, unknown>)
      : ''
  return text ? `请求失败 (${status}): ${text}` : `请求失败 (${status})`
}

/**
 * 从响应体里取可展示文本。
 *
 * 两条协议并存：插件自报路由回 `{ error }`；h3 的错误响应回
 * `{ statusMessage, message }`（`createError` / 未捕获异常走这条）。
 * 两者都读，客户端才能对两类错误给出同样的文案质量。
 */
function readErrorText(body: Record<string, unknown>): string {
  for (const key of ['error', 'message', 'statusMessage'] as const) {
    const value = body[key]
    if (typeof value === 'string' && value.length > 0)
      return value
  }
  return ''
}
