import type { AddWorkspaceRuntime, ClientContext } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { resolveAddWorkspace, resolveStartSession } from './compat'

/**
 * 构造只带 `ctx.get` 的最小客户端上下文：compat 的能力探测完全基于
 * `ctx.get(name)` 的返回形态（不读 ctx 属性，避免 Cordis 的 inject 守卫）。
 */
function makeContext(services: Record<string, unknown>): ClientContext {
  return {
    get: (name: string) => services[name],
  } as unknown as ClientContext
}

/** 断言能力可用（tsc/lint 友好的非空收窄，不用 `!` 断言）。 */
function requireRuntime(ctx: ClientContext): AddWorkspaceRuntime {
  const runtime = resolveAddWorkspace(ctx)
  if (runtime === undefined)
    throw new Error('resolveAddWorkspace returned undefined')
  return runtime
}

describe('resolveStartSession', () => {
  it('prefers uiWorkspace and falls back to workspaces', () => {
    const uiStart = vi.fn()
    const wsStart = vi.fn()
    const uiContext = makeContext({ uiWorkspace: { startSession: uiStart } })
    const rcContext = makeContext({ workspaces: { startSession: wsStart } })

    resolveStartSession(uiContext)?.('w1')
    resolveStartSession(rcContext)?.()

    // this 必须绑定到各自的服务实例上（方法被解构后仍能工作）
    expect(uiStart).toHaveBeenCalledWith('w1')
    expect(uiStart.mock.instances[0]).toMatchObject({ startSession: uiStart })
    expect(wsStart).toHaveBeenCalledWith(undefined)
  })

  it('returns undefined when no navigation service exists', () => {
    expect(resolveStartSession(makeContext({}))).toBeUndefined()
    expect(resolveStartSession(makeContext({ workspaces: {} }))).toBeUndefined()
  })
})

describe('resolveAddWorkspace', () => {
  it('binds pickDirectory / create / startSession to their owners', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('D:/work/demo')
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1', path: 'D:/work/demo' })
    const startSession = vi.fn()
    const runtime = requireRuntime(makeContext({
      uiWorkspace: { pickDirectory, startSession },
      workspaces: { create },
    }))

    const path = await runtime.pickDirectory()
    expect(path).toBe('D:/work/demo')
    expect(pickDirectory.mock.instances[0]).toMatchObject({ pickDirectory })

    const workspace = await runtime.createWorkspace({ path: 'D:/work/demo' })
    expect(workspace.workspaceId).toBe('w1')
    expect(create).toHaveBeenCalledWith({ path: 'D:/work/demo' })
    expect(create.mock.instances[0]).toMatchObject({ create })

    runtime.startSession(workspace.workspaceId)
    expect(startSession).toHaveBeenCalledWith('w1')
  })

  it('reports unavailable when any capability is missing', () => {
    const startSession = vi.fn()
    const create = vi.fn()
    // 缺 pickDirectory（目录选择器远程服务未注册）
    expect(resolveAddWorkspace(makeContext({ uiWorkspace: { startSession }, workspaces: { create } }))).toBeUndefined()
    // 缺 workspaces.create（只有导航服务）
    expect(resolveAddWorkspace(makeContext({ uiWorkspace: { startSession, pickDirectory: vi.fn() } }))).toBeUndefined()
    // 缺会话导航（无法在新工作区开会话）
    expect(resolveAddWorkspace(makeContext({ uiWorkspace: { pickDirectory: vi.fn() }, workspaces: { create } }))).toBeUndefined()
  })
})
