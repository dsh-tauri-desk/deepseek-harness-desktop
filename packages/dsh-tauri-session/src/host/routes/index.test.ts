/**
 * host/routes/index.test.ts — 归档路由声明的协议回归（RESTful 资源化后）。
 *
 * 覆盖（迁移契约）：路由表的 (kind, path) 与声明方法、方法不符时 405 + allow 头、
 * OPTIONS 预检 204、GET /session/archive 的载荷形状、POST /session/open-path 的 400
 * 领域错误、DELETE 路由的请求体仍按 JSON 解析、`/session/archive/clear` 的 POST 与
 * DELETE 双方法登记。
 *
 * 走真实 node:http 服务（h3 的 toNodeHandler 依赖真实 req/res 流），并在测试内复刻
 * 宿主 webserver 的 exact 匹配契约；连接鉴权 / 回环 / 跨源边界由 dsh-tauri 的
 * `defineRoutes` 统一承担（其自身已有覆盖），这里只锁本插件的路径、方法与响应形状。
 * 领域服务经 `getCurrentHostInstance()` 取宿主，故挂载前先绑定同一份假 ctx。
 */

import type { HostRoute, RoutesContext } from 'dsh-tauri'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from '.'
import { SESSION_API_PREFIX as P } from '../../shared/constants'
import { setCurrentHostInstance } from '../config/runtime'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

/**
 * RESTful 资源化后的路由表（方法 + URL），防止声明漂移。
 * URL 与 `routes/` 下的文件路径一一对应：`session/archive/delete.ts` → DELETE /session/archive。
 */
const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `${P}/session/archive`],
  ['POST', `${P}/session/archive`],
  ['DELETE', `${P}/session/archive`],
  ['POST', `${P}/session/archive/clear`],
  ['DELETE', `${P}/session/archive/clear`],
  ['POST', `${P}/session/workspace/archive`],
  ['DELETE', `${P}/session/workspace/archive`],
  ['POST', `${P}/session/unarchive`],
  ['POST', `${P}/session/open-path`],
]

/** 去重后的宿主注册行（同一路径的多个方法由 defineRoutes 收敛为一行）。 */
const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

/**
 * 每条路径的 allow 头（规范顺序：GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS；
 * 声明 GET 即隐含 HEAD）。
 */
const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [`${P}/session/archive`]: 'GET, HEAD, POST, DELETE, OPTIONS',
  [`${P}/session/archive/clear`]: 'POST, DELETE, OPTIONS',
  [`${P}/session/workspace/archive`]: 'POST, DELETE, OPTIONS',
  [`${P}/session/unarchive`]: 'POST, OPTIONS',
  [`${P}/session/open-path`]: 'POST, OPTIONS',
}

/** 所有路径都未声明 PUT，用于统一验证 405 + allow。 */
const UNDECLARED_METHOD = 'PUT'

interface Harness {
  ctx: unknown
  registered: Map<string, HostRoute>
}

/** 假宿主 ctx：注册表模拟宿主 webserver（重复 (kind,path) 抛错，disposer 删行）。 */
function createHarness(): Harness {
  const registered = new Map<string, HostRoute>()
  return {
    registered,
    ctx: {
      webServer: {
        register(route: HostRoute): () => void {
          const key = routeKey(route.kind, route.path)
          if (registered.has(key))
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
          registered.set(key, route)
          return () => {
            registered.delete(key)
          }
        },
      },
      logger: { error: () => {} },
      // 业务面：插件 HostContext 的扩展点，defineRoutes 只把 ctx 原样透传给 handler。
      sessions: {
        get: (id: string) => (id === 'archived-1'
          ? { id, header: { createdAt: 1_700_000_000_000, cwd: 'C:/project' } }
          : undefined),
      },
      workspaceRegistry: { archivedSessionIds: ['archived-1'] },
    },
  }
}

/** 按协议注册：绑定宿主实例（领域服务经 getCurrentHostInstance 读取）后注册路由。 */
function mount(harness: Harness): () => void {
  setCurrentHostInstance(harness.ctx as never)
  return routes(harness.ctx as RoutesContext)
}

const servers: Server[] = []

/** 复刻宿主 webserver 的 exact 匹配契约，起一个真实 HTTP 服务并返回 base URL。 */
async function listen(registered: Map<string, HostRoute>): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = registered.get(routeKey('exact', pathname))
    if (!route) {
      response.writeHead(404)
      response.end()
      return
    }
    Promise.resolve(route.handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** 发一个 JSON 请求（body 为原始字符串，便于构造非法体）。 */
function postJson(base: string, path: string, method: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('归档路由声明', () => {
  it('按 RESTful 资源树声明 exact 路由，同路径多方法收敛为一行，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    // 9 条 (方法, 路径) 声明收敛为 5 条宿主注册行。
    expect(EXPECTED_ROUTES).toHaveLength(9)
    expect(harness.registered.size).toBe(5)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('gET /session/archive 返回宿主归档集合与每个会话的元数据', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/session/archive`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      archivedSessionIds: ['archived-1'],
      meta: { 'archived-1': { createdAt: 1_700_000_000_000, cwd: 'C:/project' } },
    })

    dispose()
  })

  it('未声明的方法返回 405 + allow 头（每条路径的方法集与声明一致）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const path of EXPECTED_PATHS) {
      const response = await fetch(`${base}${path}`, { method: UNDECLARED_METHOD })
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow'), path).toBe(ALLOW_BY_PATH[path])
    }

    dispose()
  })

  it('已声明的 (方法, 路径) 都能进到处理器（不被 405 挡下）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const [method, path] of EXPECTED_ROUTES) {
      // GET/HEAD 按 fetch 规范不能带请求体，其余方法统一带一个 JSON 空对象。
      const response = method === 'GET' || method === 'HEAD'
        ? await fetch(`${base}${path}`, { method })
        : await postJson(base, path, method, '{}')
      expect(response.status, `${method} ${path}`).not.toBe(405)
    }

    dispose()
  })

  it('oPTIONS 预检返回 204 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const archive = await fetch(`${base}${P}/session/archive`, { method: 'OPTIONS' })
    expect(archive.status).toBe(204)
    expect(archive.headers.get('allow')).toBe('GET, HEAD, POST, DELETE, OPTIONS')

    const clear = await fetch(`${base}${P}/session/archive/clear`, { method: 'OPTIONS' })
    expect(clear.status).toBe(204)
    expect(clear.headers.get('allow')).toBe('POST, DELETE, OPTIONS')

    dispose()
  })

  it('/session/archive/clear 的 POST 与 DELETE 都登记到同一处理器', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    // 两种方法都必须被路由（不是 405），且落到同一个处理器 → 同一状态码。
    const post = await fetch(`${base}${P}/session/archive/clear`, { method: 'POST' })
    const del = await fetch(`${base}${P}/session/archive/clear`, { method: 'DELETE' })
    expect(post.status).not.toBe(405)
    expect(del.status).not.toBe(405)
    expect(del.status).toBe(post.status)

    dispose()
  })

  it('dELETE 路由的请求体仍按 JSON 解析并走领域校验', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    // 空对象 → 处理器体内的 sessionId 校验（在触碰领域服务之前）给出 400 领域错误。
    const missingId = await postJson(base, `${P}/session/archive`, 'DELETE', '{}')
    expect(missingId.status).toBe(400)
    expect(await missingId.json()).toEqual({ ok: false, error: 'invalid-session-id' })

    const missingIds = await postJson(base, `${P}/session/workspace/archive`, 'DELETE', '{}')
    expect(missingIds.status).toBe(400)
    expect(await missingIds.json()).toEqual({ ok: false, error: 'invalid-session-ids' })

    // 非法 JSON 体同样在读体阶段结束为 400。
    const invalidJson = await postJson(base, `${P}/session/archive`, 'DELETE', 'not-json')
    expect(invalidJson.status).toBe(400)

    dispose()
  })

  it('pOST /session/open-path 缺少 sessionId 或目录不存在时返回 400 领域错误', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const missing = await postJson(base, `${P}/session/open-path`, 'POST', '{}')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ ok: false, error: 'invalid-session-id' })

    const unknown = await postJson(
      base,
      `${P}/session/open-path`,
      'POST',
      JSON.stringify({ sessionId: '__missing_session__' }),
    )
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ ok: false, error: 'session-directory-not-found' })

    dispose()
  })

  it('非对象 / 非法 JSON / 非 JSON 编码体返回 400', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const arrayBody = await postJson(base, `${P}/session/open-path`, 'POST', '[]')
    expect(arrayBody.status).toBe(400)

    const invalidJson = await postJson(base, `${P}/session/open-path`, 'POST', 'not-json')
    expect(invalidJson.status).toBe(400)

    // 请求体一律按 JSON 解析：urlencoded 体不会被当成合法对象放行。
    const urlencoded = await fetch(`${base}${P}/session/open-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=archived-1',
    })
    expect(urlencoded.status).toBe(400)

    dispose()
  })
})
