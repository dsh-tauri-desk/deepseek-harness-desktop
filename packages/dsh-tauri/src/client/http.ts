/**
 * Shared JSON HTTP client for browser halves that call a plugin host route.
 *
 * This stays dependency-free because the client bundle is loaded by DSH's
 * ModuleLoader; a small common primitive is safer than adding a copy of an
 * HTTP library to every plugin's published client artifact.
 */

export interface JsonRequestOptions {
  /** Abort the request after this many milliseconds; omit to disable timeout. */
  timeoutMs?: number
  /** Convert a failed response into the plugin's localized error message. */
  errorMessage?: (status: number, body: unknown) => string
  /** Convert an abort caused by timeout into the plugin's localized message. */
  timeoutMessage?: string
}

function defaultErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error.length > 0)
      return error
  }
  return `HTTP ${status}`
}

/**
 * Request a JSON endpoint with consistent response decoding and timeout cleanup.
 * Mutation callers must opt into their own retry policy; this helper never retries.
 */
export async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  options: JsonRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs
  const timeoutEnabled = timeoutMs !== undefined && timeoutMs > 0
  const controller = timeoutEnabled ? new AbortController() : undefined
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  if (controller !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    if (init.signal !== undefined) {
      if (init.signal.aborted)
        controller.abort()
      else
        init.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }

  try {
    const headers = new Headers(init.headers)
    if (!headers.has('content-type') && init.body !== undefined)
      headers.set('content-type', 'application/json')
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      ...(controller !== undefined ? { signal: controller.signal } : {}),
    })
    const text = await response.text()
    const body: unknown = text.length > 0 ? JSON.parse(text) : undefined
    if (!response.ok)
      throw new Error((options.errorMessage ?? defaultErrorMessage)(response.status, body))
    return body as T
  }
  catch (error) {
    if (timedOut || (error instanceof Error && error.name === 'AbortError' && timeoutEnabled))
      throw new Error(options.timeoutMessage ?? '请求超时')
    throw error
  }
  finally {
    if (timeout !== undefined)
      clearTimeout(timeout)
  }
}

/** Create a small path-bound client for one plugin API prefix. */
export function createJsonClient(baseUrl: string, options: JsonRequestOptions = {}) {
  return {
    request: <T>(path: string, init?: RequestInit): Promise<T> => requestJson<T>(baseUrl, path, init, options),
    post: <T>(path: string, body: unknown): Promise<T> => requestJson<T>(baseUrl, path, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options),
  }
}
