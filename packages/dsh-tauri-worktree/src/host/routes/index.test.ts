import type { HostRoute, RoutesContext } from 'dsh-tauri'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Binding } from '../types'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '.'
import { resetTestDshHome } from '../../../../.test/test-utils'
import { WORKTREE_API_PREFIX as P } from '../../shared/constants'
import { clearHostRuntime } from '../config/runtime'
import { ledger } from '../service/ledger'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  const { testDshHome: home } = await import('../../../../.test/test-utils')
  return { ...actual, DSH_HOME: home }
})

const routeKey = (kind: string, path: string): string => `${kind}\u0000${path}`

const EXPECTED_PATHS: readonly string[] = [
  P,
  `${P}/bindings`,
  `${P}/status`,
  `${P}/attach`,
  `${P}/checkout`,
]

const ALLOW_BY_PATH: Readonly<Record<string, string>> = {
  [P]: 'POST, DELETE, OPTIONS',
  [`${P}/bindings`]: 'GET, HEAD, OPTIONS',
  [`${P}/status`]: 'GET, HEAD, OPTIONS',
  [`${P}/attach`]: 'POST, OPTIONS',
  [`${P}/checkout`]: 'POST, OPTIONS',
}

const UNDECLARED_METHOD = 'PUT'

interface Harness {
  registered: Map<string, HostRoute>
  ctx: RoutesContext
}

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
const temporaryDirectories: string[] = []

beforeEach(() => {
  resetTestDshHome()
  clearHostRuntime()
})

afterEach(async () => {
  clearHostRuntime()
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

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

function sendJson(base: string, path: string, method: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function createBinding(sessionId: string, worktreePath: string): Binding {
  return {
    sessionId,
    sourceSessionId: 'source-a',
    hash: 'hash-a',
    dirname: 'repo',
    worktreePath,
    projectPath: '/tmp/repo',
    branchName: 'dsh/x',
    ownsBranch: true,
    createdAt: new Date().toISOString(),
    log: ['created'],
  }
}

describe('工作树路由声明', () => {
  it('声明 5 条 exact 路径共 6 条路由，卸载后清空注册', () => {
    const harness = createHarness()
    const dispose = routes(harness.ctx)

    expect([...harness.registered.keys()].sort())
      .toEqual(EXPECTED_PATHS.map(path => routeKey('exact', path)).sort())
    expect(harness.registered.size).toBe(EXPECTED_PATHS.length)

    dispose()
    expect(harness.registered.size).toBe(0)
  })

  it('未声明的方法返回 405 + allow 头', async () => {
    const harness = createHarness()
    const dispose = routes(harness.ctx)
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
    const dispose = routes(harness.ctx)
    const base = await listen(harness.registered)

    const collection = await fetch(`${base}${P}`, { method: 'OPTIONS' })
    expect(collection.status).toBe(204)
    expect(collection.headers.get('allow')).toBe('POST, DELETE, OPTIONS')

    const status = await fetch(`${base}${P}/status`, { method: 'OPTIONS' })
    expect(status.status).toBe(204)
    expect(status.headers.get('allow')).toBe('GET, HEAD, OPTIONS')

    dispose()
  })

  it('缺 sessionId 的写路由返回 400', async () => {
    const harness = createHarness()
    const dispose = routes(harness.ctx)
    const base = await listen(harness.registered)

    for (const path of [P, `${P}/attach`]) {
      const response = await sendJson(base, path, 'POST', '{}')
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({ error: '缺少 sessionId' })
    }

    dispose()
  })
})

describe('工作树路由响应', () => {
  it('账本为空时 /bindings 返回空列表', async () => {
    const harness = createHarness()
    const dispose = routes(harness.ctx)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/bindings`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ bindings: [], jobs: [] })

    dispose()
  })

  it('/bindings 只列出工作树目录仍存在的绑定', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
    temporaryDirectories.push(directory)
    const live = join(directory, 'live')
    mkdirSync(live, { recursive: true })
    await ledger.save('session-live', createBinding('session-live', live))
    await ledger.save('session-gone', createBinding('session-gone', join(directory, 'gone')))

    const harness = createHarness()
    const dispose = routes(harness.ctx)
    const base = await listen(harness.registered)

    const body = await (await fetch(`${base}${P}/bindings`)).json() as {
      bindings: Array<{ sessionId: string, worktreeKey: string }>
    }
    expect(body.bindings.map(binding => binding.sessionId)).toEqual(['session-live'])
    expect(body.bindings[0].worktreeKey).toBe('hash-a/repo')

    dispose()
  })

  it('无绑定时 /status 返回本地工作区事实', async () => {
    const harness = createHarness()
    const dispose = routes(harness.ctx)
    const base = await listen(harness.registered)

    const response = await fetch(`${base}${P}/status?sessionId=session-none`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: 'local', projectPath: '', isGit: null })

    dispose()
  })

  it('dELETE 集合根对已消失的确定性路径幂等成功', async () => {
    const harness = createHarness()
    const dispose = routes(harness.ctx)
    const base = await listen(harness.registered)

    const response = await sendJson(base, P, 'DELETE', JSON.stringify({
      sessionId: 'session-none',
      worktreeHashDirname: 'hash-none/repo',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    dispose()
  })
})
