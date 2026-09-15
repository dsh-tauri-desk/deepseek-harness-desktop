/**
 * register/index.adapter.test.ts — DSH 升级迁移适配层的边界测试。
 *
 * 覆盖：modern / legacy 两种服务布局的世代探测与投影、方法 this 绑定与 list 引用稳定性、
 * Cordis inject 守卫抛错与属性回退、DOM 退级与「不可用」明确回报、`addWorkspace` 全流程与
 * 用户取消、自定义迁移的追加顺序、单条迁移失败不中断装配。
 *
 * 用例只用 `ctx.get` / `ctx[name]` 的返回形态构造上下文（与真实探测路径一致）；
 * DOM 依赖用 `vi.stubGlobal('document', …)` 提供最小假实现（仓库未装 jsdom）。
 */
import type { AdapterAddWorkspaceRuntime, AdapterRuntimeObject, ClientAdapter, DshMigration } from './index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineAdapter } from './index'

/** 假 ObservableSnapshot（`list.subscribe` / `list.getSnapshot`）。 */
function makeList(snapshot: unknown = { ids: [] }): {
  getSnapshot: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
}

/** 只带 `ctx.get` 的最小客户端上下文（探测完全基于它的返回形态）。 */
function makeContext(services: Record<string, unknown>): unknown {
  return { get: (name: string) => services[name] }
}

/** 非空收窄（tsc / lint 友好的断言辅助，不用 `!`）。 */
function requireAddWorkspace(adapter: ClientAdapter): AdapterAddWorkspaceRuntime {
  const runtime = adapter.resolveAddWorkspace()
  if (runtime === undefined)
    throw new Error('resolveAddWorkspace returned undefined')
  return runtime
}

/** 每个用例一个安静告警出口：只记录，不打印。 */
function makeWarn() {
  return vi.fn<(message: string, error?: unknown) => void>()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('defineAdapter — 世代探测与内置迁移', () => {
  it('modern 布局：sessions.list 即投影，导航与目录选择都在 workspaces', () => {
    const sessionsList = makeList()
    const workspacesList = makeList()
    const adapter = defineAdapter(makeContext({
      sessions: { list: sessionsList },
      workspaces: {
        list: workspacesList,
        create: vi.fn(),
        pickDirectory: vi.fn(),
        startSession: vi.fn(),
      },
    }))

    expect(adapter.generation).toBe('modern')
    // legacy 的工作区导航投影不该在 modern 布局上出现（uiWorkspace 缺席）
    expect(adapter.migrations).toContain('services:auto-bind')
    expect(adapter.migrations).toContain('sessions:list-projection')
    expect(adapter.migrations).not.toContain('legacy:workspaces-navigation')
    expect(adapter.migrations).not.toContain('sessions:provide-info-bridge')
    expect(adapter.migrations).toContain('navigation:resolve-start-session')
    expect(adapter.migrations).toContain('workspace:resolve-add-workspace')
    expect(adapter.failures).toEqual([])

    // 顶层别名是同一份 feed 的转发（老写法读 ctx.sessions.getSnapshot 也能用）
    expect(adapter.sessions.getSnapshot?.()).toEqual({ ids: [] })
    expect(adapter.sessions.list?.getSnapshot()).toEqual({ ids: [] })

    expect(adapter.has('sessions.list')).toBe(true)
    expect(adapter.has('workspaces.list')).toBe(true)
    expect(adapter.has('workspaces.create')).toBe(true)
    expect(adapter.has('navigation.startSession')).toBe(true)
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
    // modern 的 sessions 面没有 legacy 的 per-session 查询，且无 uiSession 桥可用
    expect(adapter.has('sessions.provideInfo')).toBe(false)
  })

  it('legacy 布局：uiWorkspace 提供导航与目录选择，sessions 嵌套投影被补齐', () => {
    const snapshot = { ids: ['s1'] }
    const list = makeList(snapshot)
    const startSession = vi.fn()
    const connectWorkspace = vi.fn()
    const pickDirectory = vi.fn()
    const resolve = vi.fn(() => ({ props: { inputActions: { submit: true } } }))
    const adapter = defineAdapter(makeContext({
      sessions: { list, binding: vi.fn(() => ({})) },
      uiWorkspace: { startSession, connectWorkspace, pickDirectory },
      uiSession: { adapter: { resolve } },
    }))

    expect(adapter.generation).toBe('legacy')
    expect(adapter.migrations).toContain('sessions:list-projection')
    expect(adapter.migrations).toContain('sessions:provide-info-bridge')
    expect(adapter.migrations).toContain('legacy:workspaces-navigation')

    // 嵌套投影补齐成与新版同形的 getSnapshot / subscribe
    expect(adapter.sessions.getSnapshot?.()).toEqual(snapshot)
    const listener = () => {}
    adapter.sessions.subscribe?.(listener)
    expect(list.subscribe).toHaveBeenCalledWith(listener)

    // per-session 信息：legacy 走 binding + uiSession.adapter.resolve 投影
    expect(adapter.has('sessions.provideInfo')).toBe(true)
    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions: { submit: true } } })
    expect(resolve).toHaveBeenCalledWith('s1')

    // 导航能力落到 uiWorkspace，且 this 必须绑回该服务
    adapter.workspaces.startSession?.('w1')
    expect(startSession).toHaveBeenCalledWith('w1')
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })

    adapter.workspaces.connectWorkspace?.('w1')
    expect(connectWorkspace).toHaveBeenCalledWith('w1')

    adapter.resolveStartSession()?.('w2')
    expect(startSession).toHaveBeenCalledWith('w2')
  })

  it('provideInfo 桥原生优先：原生只覆盖部分会话时回退 binding + uiSession 投影', () => {
    const resolve = vi.fn(() => ({ props: { inputActions: { submit: true } } }))
    const adapter = defineAdapter(makeContext({
      sessions: {
        list: makeList(),
        // 原生实现只认 'native'：其余会话交给兼容桥
        provideInfo: vi.fn((sessionId: string) => (sessionId === 'native' ? { props: { native: true } } : undefined)),
        binding: vi.fn(() => ({})),
      },
      uiSession: { adapter: { resolve } },
    }))

    expect(adapter.migrations).toContain('sessions:provide-info-bridge')
    expect(adapter.sessions.provideInfo?.('native')).toEqual({ props: { native: true } })
    expect(resolve).not.toHaveBeenCalled()

    expect(adapter.sessions.provideInfo?.('s1')).toEqual({ props: { inputActions: { submit: true } } })
    expect(resolve).toHaveBeenCalledWith('s1')
  })

  it('uiWorkspace 只有目录选择时，导航回退到 workspaces 原生实现（不静默吞掉）', () => {
    const nativeStart = vi.fn()
    const pickDirectory = vi.fn().mockResolvedValue('D:/work/demo')
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1' })
    const adapter = defineAdapter(makeContext({
      uiWorkspace: { pickDirectory },
      workspaces: { startSession: nativeStart, create },
    }))

    expect(adapter.generation).toBe('legacy')
    // uiWorkspace 缺席 startSession，不该因此丢掉 workspaces 的原生导航
    expect(adapter.has('navigation.startSession')).toBe(true)
    adapter.resolveStartSession()?.('w1')
    expect(nativeStart).toHaveBeenCalledWith('w1')

    // 目录选择来自 uiWorkspace、建工作区/开会话来自 workspaces：混合宿主也能聚合
    const runtime = requireAddWorkspace(adapter)
    expect(runtime.pickDirectory).toBeTypeOf('function')
    expect(adapter.has('navigation.addWorkspace')).toBe(true)
  })

  it('官方服务方法绑定到原对象（解构后仍可用），list 投影引用稳定', () => {
    const list = makeList()
    const startSession = vi.fn()
    const adapter = defineAdapter(makeContext({
      sessions: { list, refresh: vi.fn() },
      workspaces: { list, startSession, create: vi.fn() },
    }))

    const { startSession: detached } = adapter.workspaces
    detached?.('w1')
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })

    // uSES 快照比较依赖 list 引用稳定：同一服务多次读取必须是同一个投影
    expect(adapter.sessions.list).toBe(adapter.sessions.list)
    expect(adapter.workspaces.list).toBe(adapter.workspaces.list)
  })

  it('ctx 投影替换 sessions/workspaces，其余成员透传；服务缺失时返回空投影', () => {
    const list = makeList()
    const ctx: AdapterRuntimeObject = { sessions: { list }, marker: 'keep-me', get: () => undefined }
    const adapter = defineAdapter(ctx)

    expect((adapter.ctx as AdapterRuntimeObject).sessions).toBe(adapter.sessions)
    expect((adapter.ctx as AdapterRuntimeObject).workspaces).toBe(adapter.workspaces)
    expect((adapter.ctx as AdapterRuntimeObject).marker).toBe('keep-me')

    const bare = defineAdapter({ get: () => undefined })
    expect(bare.generation).toBe('unknown')
    expect(bare.has('sessions.list')).toBe(false)
    expect(bare.has('navigation.startSession')).toBe(false)
    expect(bare.sessions.getSnapshot).toBeUndefined()
  })

  it('ctx 是 undefined / 非对象 / inject 守卫抛错时都不抛，按服务缺失处理', () => {
    expect(() => defineAdapter(undefined)).not.toThrow()
    expect(() => defineAdapter(42)).not.toThrow()
    expect(defineAdapter(undefined).generation).toBe('unknown')

    // Cordis 对未声明键的 inject-only 守卫会抛错：探测必须吞掉并当作服务不存在
    const guarded = defineAdapter({
      get: (name: string) => {
        if (name === 'sessions')
          throw new Error('inject-only property')
        return name === 'uiWorkspace' ? { startSession: vi.fn() } : undefined
      },
    })
    expect(guarded.generation).toBe('legacy')
    expect(guarded.sessions.getSnapshot).toBeUndefined()
    expect(guarded.has('navigation.startSession')).toBe(true)

    // 没有 ctx.get 时回退属性读取（非 cordis 宿主的兼容路径）
    const list = makeList()
    const attribute = defineAdapter({ sessions: { list } })
    expect(attribute.generation).toBe('modern')
    expect(attribute.sessions.list).toBeDefined()
  })
})

describe('defineAdapter — 退级阶梯（官方服务 → DOM → 明确不可用）', () => {
  it('startSession：官方服务优先，thenable 才 await', async () => {
    const startSession = vi.fn().mockResolvedValue('ok')
    const adapter = defineAdapter(makeContext({ uiWorkspace: { startSession } }), { onWarn: makeWarn() })

    await expect(adapter.startSession('w1')).resolves.toEqual({ status: 'started', value: 'ok' })
    expect(startSession).toHaveBeenCalledWith('w1')

    // 同步返回值不做无意义等待：outcome 立刻可用
    const sync = vi.fn()
    const syncAdapter = defineAdapter(makeContext({ uiWorkspace: { startSession: sync } }), { onWarn: makeWarn() })
    await expect(syncAdapter.startSession()).resolves.toEqual({ status: 'started', value: undefined })
  })

  it('startSession：服务缺席时点官方按钮，按钮也缺席才回报不可用并告警', async () => {
    const click = vi.fn()
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ click })) })
    const delegated = defineAdapter(undefined, { onWarn: makeWarn() })
    expect(delegated.has('dom.newSession')).toBe(true)
    await expect(delegated.startSession()).resolves.toEqual({ status: 'delegated' })
    expect(click).toHaveBeenCalledTimes(1)

    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    const warn = makeWarn()
    const unavailable = defineAdapter(undefined, { onWarn: warn })
    const outcome = await unavailable.startSession()
    expect(outcome.status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('startSession unavailable')
  })

  it('addWorkspace：官方三段能力全流程', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('D:/work/demo')
    const create = vi.fn().mockResolvedValue({ workspaceId: 'w1' })
    const startSession = vi.fn()
    const adapter = defineAdapter(
      makeContext({ workspaces: { pickDirectory, create, startSession } }),
      { onWarn: makeWarn() },
    )

    await expect(adapter.addWorkspace()).resolves.toEqual({
      status: 'created',
      workspaceId: 'w1',
      path: 'D:/work/demo',
      sessionStarted: true,
    })
    expect(create).toHaveBeenCalledWith({ path: 'D:/work/demo' })
    expect(startSession).toHaveBeenCalledWith('w1')
    // 方法必须绑到各自的服务实例上
    expect(pickDirectory.mock.instances[0]).toMatchObject({ pickDirectory })
    expect(startSession.mock.instances[0]).toMatchObject({ startSession })
  })

  it('addWorkspace：用户取消是正常结果；openSession:false 不建会话', async () => {
    const create = vi.fn()
    const startSession = vi.fn()
    const cancelled = defineAdapter(
      makeContext({ workspaces: { pickDirectory: vi.fn().mockResolvedValue(null), create, startSession } }),
      { onWarn: makeWarn() },
    )
    await expect(cancelled.addWorkspace()).resolves.toEqual({ status: 'cancelled' })
    expect(create).not.toHaveBeenCalled()

    const adapter = defineAdapter(
      makeContext({
        workspaces: {
          pickDirectory: vi.fn().mockResolvedValue('D:/work/demo'),
          create: vi.fn().mockResolvedValue({ workspaceId: 'w1' }),
          startSession,
        },
      }),
      { onWarn: makeWarn() },
    )
    await expect(adapter.addWorkspace({ openSession: false })).resolves.toMatchObject({
      status: 'created',
      sessionStarted: false,
    })
    expect(startSession).not.toHaveBeenCalled()
  })

  it('addWorkspace：三段能力缺一时点官方按钮，按钮也缺席才回报不可用', async () => {
    // 缺 workspaces.create
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ click: vi.fn() })) })
    const delegated = defineAdapter(
      makeContext({ workspaces: { pickDirectory: vi.fn(), startSession: vi.fn() } }),
      { onWarn: makeWarn() },
    )
    expect(delegated.has('navigation.addWorkspace')).toBe(false)
    await expect(delegated.addWorkspace()).resolves.toEqual({ status: 'delegated' })

    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    const warn = makeWarn()
    const unavailable = defineAdapter(undefined, { onWarn: warn })
    const outcome = await unavailable.addWorkspace()
    expect(outcome.status).toBe('unavailable')
    expect(warn.mock.calls[0][0]).toContain('addWorkspace unavailable')
  })
})

describe('defineAdapter — 迁移注册表', () => {
  it('自定义迁移在默认迁移之后执行，可覆盖既有投影', async () => {
    const custom = vi.fn()
    const migration: DshMigration = {
      id: 'test:custom-navigation',
      detect: () => true,
      apply(surface) {
        surface.startSession = () => custom()
      },
    }
    const adapter = defineAdapter(makeContext({ uiWorkspace: { startSession: vi.fn() } }), {
      migrations: [migration],
      onWarn: makeWarn(),
    })

    expect(adapter.migrations.at(-1)).toBe('test:custom-navigation')
    await adapter.startSession('w1')
    expect(custom).toHaveBeenCalledTimes(1)
  })

  it('detect 为 false 的迁移不执行、不记入 migrations', () => {
    const apply = vi.fn()
    const adapter = defineAdapter(undefined, {
      migrations: [{ id: 'test:skipped', detect: () => false, apply }],
      onWarn: makeWarn(),
    })

    expect(apply).not.toHaveBeenCalled()
    expect(adapter.migrations).not.toContain('test:skipped')
    expect(adapter.failures).toEqual([])
  })

  it('单条迁移失败只记录 failures 并告警，后续迁移与装配照常', () => {
    const late = vi.fn()
    const warn = makeWarn()
    const adapter = defineAdapter(undefined, {
      migrations: [
        {
          id: 'test:boom',
          detect: () => true,
          apply: () => {
            throw new Error('projection failed')
          },
        },
        { id: 'test:late', detect: () => true, apply: surface => void (surface.startSession = () => late()) },
      ],
      onWarn: warn,
    })

    expect(adapter.failures.map(failure => failure.migration)).toEqual(['test:boom'])
    expect(adapter.migrations).not.toContain('test:boom')
    expect(adapter.migrations).toContain('test:late')
    expect(warn.mock.calls[0][0]).toContain('test:boom')
    expect(adapter.has('navigation.startSession')).toBe(true)
  })
})
