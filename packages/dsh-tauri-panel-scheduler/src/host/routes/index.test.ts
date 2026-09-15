/**
 * host/routes/index.test.ts — 调度器路由声明的协议回归。
 *
 * 覆盖（迁移契约）：路由表的 (kind, path) 与声明方法、未声明方法 405 + allow 头、
 * OPTIONS 预检 204、以及请求级校验的 400 领域错误（缺 id / 非法请求体）。
 *
 * 走真实 node:http 服务（h3 的 toNodeHandler 依赖真实 req/res 流），并在测试内复刻
 * 宿主 webserver 的 exact 匹配契约；连接鉴权 / 回环 / 跨源边界由 dsh-tauri 的
 * `defineRoutes` 统一承担（其自身已有覆盖），这里只锁本插件的路径、方法与响应形状。
 *
 * 只断言「不落盘」的路径：400 校验分支在任何 storage 读写之前返回，因此测试不会
 * 触碰真实的 crons 功能目录。
 */

import type { HostRoute, RoutesContext } from 'dsh-tauri'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from '.'
import { SCHEDULER_API_PREFIX as P } from '../../shared/constants'

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

/** 迁移后的路由表：10 条 (方法, 路径) 声明，逐条与迁移前的契约一一对应。 */
const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', `${P}/tasks`],
  ['POST', `${P}/tasks/create`],
  ['POST', `${P}/tasks/update`],
  ['POST', `${P}/tasks/toggle`],
  ['POST', `${P}/tasks/delete`],
  ['POST', `${P}/tasks/run`],
  ['POST', `${P}/history/delete`],
  ['GET', `${P}/history`],
  ['GET', `${P}/options`],
  ['POST', `${P}/recover`],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

/** 每条路径的 allow 头（规范顺序：GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS；声明 GET 即隐含 HEAD）。 */
const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [`${P}/tasks`]: 'GET, HEAD, OPTIONS',
  [`${P}/tasks/create`]: 'POST, OPTIONS',
  [`${P}/tasks/update`]: 'POST, OPTIONS',
  [`${P}/tasks/toggle`]: 'POST, OPTIONS',
  [`${P}/tasks/delete`]: 'POST, OPTIONS',
  [`${P}/tasks/run`]: 'POST, OPTIONS',
  [`${P}/history/delete`]: 'POST, OPTIONS',
  [`${P}/history`]: 'GET, HEAD, OPTIONS',
  [`${P}/options`]: 'GET, HEAD, OPTIONS',
  [`${P}/recover`]: 'POST, OPTIONS',
}

/** 所有路径都未声明 PUT，用于统一验证 405 + allow。 */
const UNDECLARED_METHOD = 'PUT'

interface Harness {
  registered: Map<string, HostRoute>
  ctx: RoutesContext
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** 发一个 JSON 请求（body 为原始字符串，便于构造非法体）。 */
function postJson(base: string, path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

/** 注册全部路由并返回本次注册的卸载函数。 */
function mount(harness: Harness): () => void {
  return routes(harness.ctx)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('调度器路由声明', () => {
  it('声明 10 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(EXPECTED_ROUTES).toHaveLength(10)
    expect(harness.registered.size).toBe(10)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('未声明的方法返回 405 + allow 头（每条路径与迁移前一致）', async () => {
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

  it('预检 OPTIONS 返回 204 并带 allow 头', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const tasks = await fetch(`${base}${P}/tasks`, { method: 'OPTIONS' })
    expect(tasks.status).toBe(204)
    expect(tasks.headers.get('allow')).toBe('GET, HEAD, OPTIONS')

    const run = await fetch(`${base}${P}/tasks/run`, { method: 'OPTIONS' })
    expect(run.status).toBe(204)
    expect(run.headers.get('allow')).toBe('POST, OPTIONS')

    dispose()
  })

  it('缺 id 的写路由返回 400 与迁移前一致的错误文案（在任何落盘之前）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const cases: ReadonlyArray<readonly [string, string]> = [
      [`${P}/tasks/update`, '缺少任务 id'],
      [`${P}/tasks/toggle`, '缺少任务 id'],
      [`${P}/tasks/delete`, '缺少任务 id'],
      [`${P}/tasks/run`, '缺少任务 id'],
      [`${P}/history/delete`, '缺少执行记录 id'],
    ]
    for (const [path, error] of cases) {
      const response = await postJson(base, path, '{}')
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({ error })
    }

    // id 类型不符（数字）同样按缺省处理，不被当作合法 id 放行。
    const wrongType = await postJson(base, `${P}/tasks/delete`, JSON.stringify({ id: 42 }))
    expect(wrongType.status).toBe(400)
    expect(await wrongType.json()).toEqual({ error: '缺少任务 id' })

    dispose()
  })

  it('非法请求体在 create 路由返回 400（校验先于落盘）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const empty = await postJson(base, `${P}/tasks/create`, JSON.stringify({}))
    expect(empty.status).toBe(400)

    const invalidJson = await postJson(base, `${P}/tasks/create`, 'not-json')
    expect(invalidJson.status).toBe(400)

    dispose()
  })
})
