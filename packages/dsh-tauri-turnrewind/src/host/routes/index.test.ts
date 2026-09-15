/**
 * host/routes/index.test.ts — turnrewind 路由声明的协议回归。
 *
 * 覆盖（迁移契约）：路由表的 (kind, path) 与声明方法、未声明方法 405 + allow 头、
 * OPTIONS 预检 204、请求级校验的 400 领域错误，以及两次注册的隔离——同一份声明注册到
 * 两个宿主 ctx 时注册表各自独立、卸载互不影响。
 *
 * 处理器不再接收 apply 期依赖（`dshRouteDepsOf` 已删除）：宿主能力一律经 `service/`
 * 访问，所以这里 mock 处理器直接读取的服务模块（ledger / workspace / capture / undo）。
 *
 * 走真实 node:http 服务（h3 的 toNodeHandler 依赖真实 req/res 流），并在测试内复刻
 * 宿主 webserver 的 exact 匹配契约；连接鉴权 / 回环 / 跨源边界由 dsh-tauri 的
 * `defineRoutes` 统一承担（其自身已有覆盖），这里只锁本插件的路径、方法与响应形状。
 *
 * 只断言「不落盘」的路径：400 校验分支在任何账本/git 读写之前返回，因此测试不会触碰
 * 真实的 DSH 数据目录。
 */

import type { HostRoute, RoutesContext } from 'dsh-tauri'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LiveSnapshot } from '../types'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '.'
import { resetTestDshHome } from '../../../../.test/test-utils'
import { TURNREWIND_API_PREFIX as P } from '../../shared/constants'
import { clearHostRuntime } from '../config/runtime'
import { capture } from '../service/capture'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

/** 处理器只读服务模块：替身服务让路由测试不落盘、不建捕获编排器。 */
vi.mock('../service/capture', () => ({ capture: { live: vi.fn() } }))
vi.mock('../service/ledger', () => ({
  ledger: {
    load: async () => ({
      version: 1,
      sessionId: 'session',
      workspaceRoot: null,
      isGit: false,
      unavailableReason: null,
      turns: [],
    }),
  },
}))
vi.mock('../service/undo', () => ({
  undo: { turn: async () => ({ ok: true, restored: [], removed: [], failed: [] }) },
}))
vi.mock('../service/workspace', () => ({
  workspace: {
    peek: () => true,
    resolve: async () => ({ ok: true, root: 'C:/repo', commonDir: 'C:/repo/.git' }),
  },
}))

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const SUMMARY_PATH = `${P}/session/summary`
const LIVE_PATH = `${P}/session/live`
const UNDO_PATH = `${P}/session/undo`

/** 迁移后的路由表：3 条 (方法, 路径) 声明，逐条与迁移前的契约一一对应。 */
const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', SUMMARY_PATH],
  ['GET', LIVE_PATH],
  ['POST', UNDO_PATH],
]

const EXPECTED_PATHS: readonly string[] = [...new Set(EXPECTED_ROUTES.map(([, path]) => path))]

/** 每条路径的 allow 头（规范顺序：GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS；声明 GET 即隐含 HEAD）。 */
const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [SUMMARY_PATH]: 'GET, HEAD, OPTIONS',
  [LIVE_PATH]: 'GET, HEAD, OPTIONS',
  [UNDO_PATH]: 'POST, OPTIONS',
}

/** 所有路径都未声明 PUT，用于统一验证 405 + allow。 */
const UNDECLARED_METHOD = 'PUT'

/** 替身读数：live 路由必须把 capture 服务给出的读数原样回传（按 sessionId 取）。 */
const liveReadings = new Map<string, LiveSnapshot>()

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

/** `routes(ctx)` 注册全部路由并返回本次注册的卸载函数；处理器直接读服务模块，无 deps。 */
function mount(harness: Harness): () => void {
  return routes(harness.ctx)
}

beforeEach(() => {
  resetTestDshHome()
  clearHostRuntime()
  liveReadings.clear()
  vi.mocked(capture.live).mockImplementation(sessionId =>
    liveReadings.get(sessionId) ?? { active: false, turn: null, fileCount: 0, insertions: 0, deletions: 0 })
})

afterEach(async () => {
  clearHostRuntime()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('turnrewind 路由声明', () => {
  it('声明 3 条 exact 路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = mount(harness)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(EXPECTED_ROUTES).toHaveLength(3)
    expect(harness.registered.size).toBe(3)

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

    const summary = await fetch(`${base}${SUMMARY_PATH}`, { method: 'OPTIONS' })
    expect(summary.status).toBe(204)
    expect(summary.headers.get('allow')).toBe('GET, HEAD, OPTIONS')

    const undo = await fetch(`${base}${UNDO_PATH}`, { method: 'OPTIONS' })
    expect(undo.status).toBe(204)
    expect(undo.headers.get('allow')).toBe('POST, OPTIONS')

    dispose()
  })

  it('缺 sessionId 的读路由与缺 body 的写路由返回 400（在任何落盘之前）', async () => {
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const summary = await fetch(`${base}${SUMMARY_PATH}`)
    expect(summary.status).toBe(400)
    expect(await summary.json()).toEqual({ error: '缺少 sessionId' })

    const live = await fetch(`${base}${LIVE_PATH}`)
    expect(live.status).toBe(400)
    expect(await live.json()).toEqual({ error: '缺少 sessionId' })

    const undo = await postJson(base, UNDO_PATH, '{}')
    expect(undo.status).toBe(400)
    expect(await undo.json()).toEqual({ error: '缺少 sessionId' })

    dispose()
  })

  it('live 读数面原样回传 capture 服务给出的替身读数', async () => {
    liveReadings.set('abc', { active: true, turn: 7, fileCount: 3, insertions: 0, deletions: 0 })
    const harness = createHarness()
    const dispose = mount(harness)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${LIVE_PATH}?sessionId=abc`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      active: true,
      turn: 7,
      fileCount: 3,
      insertions: 0,
      deletions: 0,
    })

    dispose()
  })

  it('同一 routes 声明在两次注册下注册表各自独立、卸载互不影响', async () => {
    liveReadings.set('ab', { active: true, turn: 11, fileCount: 2, insertions: 0, deletions: 0 })
    liveReadings.set('abcd', { active: true, turn: 22, fileCount: 4, insertions: 0, deletions: 0 })
    const first = createHarness()
    const second = createHarness()
    const disposeFirst = mount(first)
    const disposeSecond = mount(second)
    const firstBase = await listen(first.registered)
    const secondBase = await listen(second.registered)

    const firstBody = await (await fetch(`${firstBase}${LIVE_PATH}?sessionId=ab`)).json()
    const secondBody = await (await fetch(`${secondBase}${LIVE_PATH}?sessionId=abcd`)).json()

    // 注册表各自独立，两次注册的处理器都只读自己那次注册的宿主 ctx。
    expect(firstBody).toMatchObject({ turn: 11, fileCount: 2 })
    expect(secondBody).toMatchObject({ turn: 22, fileCount: 4 })

    // 卸载其中一次不影响另一次。
    disposeFirst()
    expect(first.registered.size).toBe(0)
    expect(second.registered.size).toBe(3)
    expect(await (await fetch(`${secondBase}${LIVE_PATH}?sessionId=abcd`)).json()).toMatchObject({ turn: 22 })

    disposeSecond()
  })
})
