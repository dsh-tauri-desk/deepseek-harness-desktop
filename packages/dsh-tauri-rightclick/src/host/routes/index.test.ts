/**
 * host/routes/index.test.ts — 右键菜单路由声明的协议回归。
 *
 * 覆盖（迁移契约）：2 条路由的 (kind, path) 与声明方法、方法不符时 405 + allow 头、
 * OPTIONS 预检 204、非 JSON 内容类型 415、以及 open-url / open-path 的参数校验 400 领域错误。
 *
 * 走真实 node:http 服务（h3 的 toNodeHandler 依赖真实 req/res 流），并在测试内复刻
 * 宿主 webserver 的 exact 匹配契约；连接鉴权 / 回环 / 跨源 / 体积边界由 dsh-tauri 的
 * `defineRoutes` 统一承担（其自身已有覆盖），这里只锁本插件的路径、方法与响应形状。
 *
 * 用例只打「会被校验拒掉」的请求，绝不进入 `openUrl` / `openDirectory`（那会真的拉起 OS 进程）。
 */

import type { HostRoute, RoutesContext } from 'dsh-tauri'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from '.'
import { OPEN_PATH_ROUTE, OPEN_URL_ROUTE } from '../../shared/constants'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

/** 迁移前的路由表（路径 + 方法），防止声明漂移。 */
const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', OPEN_URL_ROUTE],
  ['POST', OPEN_PATH_ROUTE],
]

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
    },
  }
}

/** 按协议注册：`routes(ctx)` 返回本次注册的卸载函数。 */
function mount(harness: Harness): () => void {
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

/** 发一条 JSON POST（默认 application/json 内容类型）。 */
function post(base: string, path: string, body: unknown, contentType = 'application/json'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('右键菜单路由声明', () => {
  it('按迁移前的路径与方法声明 2 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_ROUTES.map(([, path]) => routeKey('exact', path)).sort())

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('变更路由拒绝读方法（405 + allow 头）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const [, path] of EXPECTED_ROUTES) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(405)
      expect(response.headers.get('allow'), path).toBe('POST, OPTIONS')
    }

    dispose()
  })

  it('oPTIONS 预检返回 204 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${OPEN_URL_ROUTE}`, { method: 'OPTIONS' })
    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe('POST, OPTIONS')

    dispose()
  })

  it('非 application/json 内容类型返回 415 unsupported-media-type', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const [, path] of EXPECTED_ROUTES) {
      const response = await post(base, path, { url: 'https://example.com', path: 'C:\\workspace' }, 'text/plain')
      expect(response.status, path).toBe(415)
      expect(await response.json(), path).toEqual({ ok: false, error: 'unsupported-media-type' })
    }

    dispose()
  })

  it('open-url 只放行 http/https（其余 400 invalid-url）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const url of ['', 'file:///etc/passwd', 'javascript:alert(1)', 42, undefined]) {
      const response = await post(base, OPEN_URL_ROUTE, { url })
      expect(response.status, String(url)).toBe(400)
      expect(await response.json(), String(url)).toEqual({ ok: false, error: 'invalid-url' })
    }

    dispose()
  })

  it('open-path 只放行本地路径（空值与 URL scheme 一律 400 invalid-path）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    for (const path of ['', '   ', 'https://example.com', 'file:///C:/workspace', 42, undefined]) {
      const response = await post(base, OPEN_PATH_ROUTE, { path })
      expect(response.status, String(path)).toBe(400)
      expect(await response.json(), String(path)).toEqual({ ok: false, error: 'invalid-path' })
    }

    dispose()
  })
})
