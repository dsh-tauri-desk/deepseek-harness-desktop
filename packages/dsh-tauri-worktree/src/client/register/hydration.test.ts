/**
 * hydration.test.ts — registerWorktreeHydration 的请求量回归测试。
 *
 * 背景：/status 复核曾把只读状态查询放大成每秒上千次请求，历经三轮收敛：
 *   1. 会话事件流逐事件复核 → 节流（每会话 ≤1 次/1.2s）；
 *   2. 未解析会话（宿主永久返回 isGit: null）被列表快照反复拉起 → 三重有界重试；
 *   3. 首轮 hydrate 为列表里每个会话各打一次 /status（实测 400 个会话 → 400 次请求）
 *      → 一次 `GET /bindings` 批量发现；事件侧改为「只在回合结束（running true→false）
 *      边沿复核一次」。
 * 本用例把「会话数、列表快照频率、流式事件频率」全部拉满，断言最终请求量与三者都无关。
 *
 * 通过 vi.mock 替换 dsh-tauri/client：既避免在 node 环境加载客户端 barrel，又把
 * fetch（HTTP 边界）与定时器收敛成可观察的替身。
 */
import type { WorktreeBindings } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISCARD_POLL_DELAY_MS, HYDRATION_RETRY_BUDGET_PER_SECOND, HYDRATION_RETRY_WINDOW_MS, SESSION_RECONCILE_MIN_INTERVAL_MS } from '../constants'
import { registerWorktreeHydration } from './hydration'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('dsh-tauri/client', () => ({
  fetch: mocks.fetch,
  createStorage: () => ({ getItem: async () => null, setItem: async () => {} }),
  localStorageDriver: () => ({}),
  createExternalStore: <T>(initial: T) => {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: (next: T | ((current: T) => T)) => {
        state = typeof next === 'function' ? (next as (current: T) => T)(state) : next
        for (const listener of [...listeners])
          listener()
      },
    }
  },
  // 最小生命周期控制器替身：timeout 走真实 setTimeout（测试用 vi.useFakeTimers 驱动），
  // dispose 清理全部定时器与 disposer，与 dsh-tauri 的语义一致。
  createLifecycleController: () => {
    let disposed = false
    const disposers = new Set<() => void>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    return {
      add: (disposer: () => void) => {
        disposers.add(disposer)
      },
      timeout: (fn: () => void, ms: number) => {
        if (disposed)
          return () => {}
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!disposed)
            fn()
        }, ms)
        timers.add(timer)
        return () => {
          timers.delete(timer)
          clearTimeout(timer)
        }
      },
      interval: () => () => {},
      listen: () => () => {},
      observe: () => ({ disconnect: () => {} }),
      isDisposed: () => disposed,
      dispose: () => {
        if (disposed)
          return
        disposed = true
        for (const timer of timers)
          clearTimeout(timer)
        timers.clear()
        for (const disposer of [...disposers])
          disposer()
        disposers.clear()
      },
    }
  },
}))

/** 可订阅的最小快照源（对应 ctx.sessions.list / ctx.workspaces.list）。 */
function snapshotSource<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next: T) => {
      state = next
      for (const listener of [...listeners])
        listener()
    },
  }
}

/** 只排空微任务队列（不推进假时钟），让首次请求的响应落到 store。 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await Promise.resolve()
}

interface HarnessOptions {
  /** 批量 /bindings 的返回体（默认空：列表里全是本地会话）。 */
  bindings?: WorktreeBindings
  /** true 时 /status 会挂起，直到 releaseStatus() 才返回（模拟慢请求/在途竞态）。 */
  holdStatus?: boolean
  /** false 时不提供 `getSnapshot()`（模拟核心版本没有 running 回合位）。 */
  runningBit?: boolean
  /** 归档会话 id（workspace 快照的 archivedSessionIds）。 */
  archived?: string[]
}

interface Harness {
  dispose: () => void
  emitSessionEvent: (sessionId?: string) => void
  setRunning: (sessionId: string, running: boolean) => void
  publishList: () => void
  publishWorkspaces: () => void
  setArchived: (ids: string[]) => void
  setCurrent: (sessionId: string) => void
  setSessionIds: (ids: string[]) => void
  statusCalls: () => number
  bindingsCalls: () => number
  discardCalls: () => number
  callsFor: (sessionId: string) => number
  subscribeCount: (sessionId: string) => number
  releaseStatus: () => void
}

const EMPTY_BINDINGS: WorktreeBindings = { bindings: [], jobs: [] }

/**
 * 装配「多会话 + 可手动触发事件流/列表快照/回合位」的 hydration 环境。
 * @param statusFor 每个会话的 /status 返回体
 * @param sessionIds 客户端列表里的会话（模拟真实 profile：几百个历史会话）
 */
function harness(
  statusFor: (sessionId: string) => Record<string, unknown>,
  sessionIds: string[] = ['s-1'],
  options: HarnessOptions = {},
): Harness {
  const runningBit = options.runningBit ?? true
  const listenersBySession = new Map<string, Set<() => void>>()
  const subscribeCalls = new Map<string, number>()
  const runningBySession = new Map<string, boolean>()
  let releaseHeld: (() => void) | null = null
  let current: string | undefined = sessionIds[0]
  let ids = [...sessionIds]
  const list = snapshotSource<{ ids: string[], current?: string }>({ ids, current })
  const workspaces = snapshotSource({ archivedSessionIds: [...(options.archived ?? [])] as string[] })

  mocks.fetch.mockImplementation(async (url: string) => {
    const target = String(url)
    if (target.includes('/bindings'))
      return options.bindings ?? EMPTY_BINDINGS
    const matched = /sessionId=([^&]+)/.exec(target)
    if (!target.includes('/status') || !matched)
      return { ok: true }
    const payload = statusFor(decodeURIComponent(matched[1]))
    if (options.holdStatus)
      await new Promise<void>((resolve) => { releaseHeld = resolve })
    return payload
  })

  const listenersOf = (id: string): Set<() => void> => {
    let listeners = listenersBySession.get(id)
    if (!listeners) {
      listeners = new Set()
      listenersBySession.set(id, listeners)
    }
    return listeners
  }

  const notify = (id: string): void => {
    for (const listener of [...listenersOf(id)])
      listener()
  }

  const ctx = {
    sessions: {
      list,
      // 每次都返回**新的** session 包装对象（真实实现下 binding() 不保证同一实例），
      // 用于验证防重绑靠的是 sessionId 而非对象身份。
      binding: (id: string) => ids.includes(id)
        ? {
            session: {
              subscribe: (listener: () => void) => {
                subscribeCalls.set(id, (subscribeCalls.get(id) ?? 0) + 1)
                const listeners = listenersOf(id)
                listeners.add(listener)
                return () => listeners.delete(listener)
              },
              ...(runningBit ? { getSnapshot: () => ({ running: runningBySession.get(id) ?? false }) } : {}),
            },
          }
        : undefined,
      open: () => {},
      refresh: async () => {},
    },
    workspaces: { list: workspaces },
  }

  const urls = (): string[] => mocks.fetch.mock.calls.map(call => String(call[0]))
  const dispose = registerWorktreeHydration(ctx as never)
  return {
    dispose,
    emitSessionEvent: (sessionId = ids[0]) => notify(sessionId),
    setRunning: (sessionId: string, running: boolean) => {
      runningBySession.set(sessionId, running)
      notify(sessionId)
    },
    publishList: () => list.publish({ ids: [...ids], current }),
    setCurrent: (sessionId: string) => {
      current = sessionId
      list.publish({ ids: [...ids], current: sessionId })
    },
    setSessionIds: (next: string[]) => {
      ids = [...next]
      list.publish({ ids: [...ids], current })
    },
    statusCalls: () => urls().filter(url => url.includes('/status')).length,
    bindingsCalls: () => urls().filter(url => url.includes('/bindings')).length,
    discardCalls: () => urls().filter(url => url.includes('/discard')).length,
    publishWorkspaces: () => workspaces.publish({ archivedSessionIds: [...(workspaces.getSnapshot().archivedSessionIds)] }),
    setArchived: (next: string[]) => workspaces.publish({ archivedSessionIds: [...next] }),
    callsFor: (sessionId: string) => {
      const pattern = new RegExp(`sessionId=${sessionId}(?:&|$)`)
      return urls().filter(url => url.includes('/status') && pattern.test(url)).length
    },
    subscribeCount: (sessionId: string) => subscribeCalls.get(sessionId) ?? 0,
    releaseStatus: () => {
      const release = releaseHeld
      releaseHeld = null
      release?.()
    },
  }
}

/** 造一个「这些会话都在工作树里」的批量绑定返回体。 */
function bindingsFor(sessionIds: string[]): WorktreeBindings {
  return {
    bindings: sessionIds.map(sessionId => ({
      sessionId,
      sourceSessionId: `src-${sessionId}`,
      hash: 'h',
      dirname: 'd',
      worktreeKey: 'h/d',
      worktreePath: `C:/wt/${sessionId}`,
      projectPath: 'C:/repo',
      log: [],
    })),
    jobs: [],
  }
}

const WORKTREE_STATUS = { mode: 'worktree', worktreeKey: 'h/d', worktreePath: 'C:/wt', projectPath: 'C:/repo', log: [], isGit: true }
const LOCAL_STATUS = { mode: 'local', projectPath: 'C:/repo', isGit: true }

describe('registerWorktreeHydration 请求量', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次加载：400 个会话只产生 1 次 /bindings（当前会话是工作树会话时 0 次 /status）', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `s-${i}`)
    const h = harness(() => WORKTREE_STATUS, ids, { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()

    expect(h.bindingsCalls()).toBe(1)
    expect(h.statusCalls()).toBe(0)
    h.dispose()
  })

  it('首次加载：当前会话是本地会话时 = 1 次 /bindings + 1 次 /status', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `s-${i}`)
    const h = harness(() => LOCAL_STATUS, ids)
    await flushMicrotasks()

    expect(h.bindingsCalls()).toBe(1)
    // 模式选择器只在当前会话渲染，只有它需要确定 isGit。
    expect(h.statusCalls()).toBe(1)
    expect(h.callsFor('s-0')).toBe(1)
    h.dispose()
  })

  it('列表快照风暴（会话集合不变）不产生任何请求', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s-${i}`)
    const h = harness(() => LOCAL_STATUS, ids, { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()
    const before = { bindings: h.bindingsCalls(), status: h.statusCalls() }

    // 10 个窗口 × 500 次快照：running/标题变化会让快照不断更新，但绑定不会变。
    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 500; i++) h.publishList()
      await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    }
    expect(h.bindingsCalls()).toBe(before.bindings)
    expect(h.statusCalls()).toBe(before.status)
    h.dispose()
  })

  it('新增会话才触发一次 /bindings', async () => {
    const h = harness(() => LOCAL_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()
    expect(h.bindingsCalls()).toBe(1)

    h.setSessionIds(['s-0', 's-1'])
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.bindingsCalls()).toBe(2)

    // 同一集合反复发布不再触发。
    for (let i = 0; i < 50; i++) h.publishList()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)
    expect(h.bindingsCalls()).toBe(2)
    h.dispose()
  })

  it('工作树会话：一个回合只在结束时复核一次（running true → false 边沿）', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']) })
    await flushMicrotasks()
    // 绑定已确定状态，无需 /status。
    expect(h.statusCalls()).toBe(0)

    // 回合开始 + 流式输出期间的上百次事件：都不复核。
    h.setRunning('s-0', true)
    for (let i = 0; i < 300; i++) h.emitSessionEvent('s-0')
    expect(h.statusCalls()).toBe(0)

    // 回合结束：复核一次。
    h.setRunning('s-0', false)
    expect(h.statusCalls()).toBe(1)

    // 结束后继续有事件（running 未变）：不再复核。
    for (let i = 0; i < 300; i++) h.emitSessionEvent('s-0')
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)
    expect(h.statusCalls()).toBe(1)

    // 下一个回合结束再来一次。
    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)
    h.dispose()
  })

  it('核心无 running 位时退回事件驱动 + 节流（功能不退化）', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']), runningBit: false })
    await flushMicrotasks()
    for (let i = 0; i < 500; i++) h.emitSessionEvent('s-0')
    // 前沿立即执行一次，其余合并为窗口末尾的拖尾执行。
    expect(h.statusCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)
    expect(h.statusCalls()).toBe(2)
    h.dispose()
  })

  it('本地会话的回合结束不触发复核（工具建的新会话由 /bindings 发现）', async () => {
    const h = harness(() => LOCAL_STATUS, ['s-0'], { bindings: bindingsFor([]) })
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(1) // 当前会话校准

    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(1)
    h.dispose()
  })

  it('宿主解析不出的当前会话：重试有界、窗口后归零、无定时器残留', async () => {
    const h = harness(() => ({ mode: 'local', projectPath: '', isGit: null }), ['s-0'])
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(1)

    // 窗口内的重试受「10s 窗口 + 全局 8 次/秒配额 + 次数上限」约束。
    for (let i = 0; i < 15; i++) {
      h.publishList()
      await vi.advanceTimersByTimeAsync(1000)
    }
    const afterWindow = h.statusCalls()
    expect(afterWindow).toBeLessThanOrEqual(1 + HYDRATION_RETRY_BUDGET_PER_SECOND * 10 + 5)

    // 越过窗口后彻底静默：再打 30s 快照 + 事件，请求与定时器都不再增长。
    for (let i = 0; i < 30; i++) {
      for (let n = 0; n < 100; n++) {
        h.publishList()
        h.emitSessionEvent('s-0')
      }
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(h.statusCalls()).toBe(afterWindow)
    expect(vi.getTimerCount()).toBe(0)
    h.dispose()
  })

  it('切回某会话时重新校准一次（放弃的会话可恢复）', async () => {
    const h = harness(() => ({ mode: 'local', projectPath: '', isGit: null }), ['s-0', 's-1'])
    await flushMicrotasks()
    expect(h.callsFor('s-0')).toBe(1)
    // 越过重试窗口，让当前会话被放弃。
    await vi.advanceTimersByTimeAsync(HYDRATION_RETRY_WINDOW_MS + 5_000)
    const settled = h.callsFor('s-0')

    h.setCurrent('s-1')
    await flushMicrotasks()
    h.setCurrent('s-0')
    await flushMicrotasks()
    expect(h.callsFor('s-0')).toBe(settled + 1)
    h.dispose()
  })

  it('同一会话只绑定一次事件订阅（binding() 每次返回新实例也不重复绑定）', async () => {
    const ids = ['s-0', 's-1', 's-2']
    const h = harness(() => WORKTREE_STATUS, ids, { bindings: bindingsFor(ids) })
    await flushMicrotasks()
    for (let i = 0; i < 200; i++) {
      h.publishList()
      await vi.advanceTimersByTimeAsync(10)
    }
    for (const id of ids)
      expect(h.subscribeCount(id)).toBe(1)
    h.dispose()
  })

  it('在途期间到达的复核经节流器：不会出现「上一次刚结束下一次立刻发」', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']), holdStatus: true })
    await flushMicrotasks()
    // 绑定已确定状态 → 无初始 /status；回合结束触发的那次请求一直挂在途。
    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    expect(h.statusCalls()).toBe(1)

    // 在途期间 again 触发：节流器把复核排入 queued（拖尾到期时命中 inFlight），不并发。
    h.setRunning('s-0', true)
    h.setRunning('s-0', false)
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(1)

    // 放行首个请求：finally 里的补跑必须仍经节流器 —— 此刻窗口刚被拖尾执行占用，
    // 因此不得立刻发第二个请求（修复前这里会直接递归 reconcileSession）。
    h.releaseStatus()
    await flushMicrotasks()
    expect(h.statusCalls()).toBe(1)

    // 只有等到下一个节流窗口才允许补跑。
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)
    h.releaseStatus()
    await flushMicrotasks()
    h.dispose()
  })

  it('归档会话完全不参与检测：即使批量绑定里持有工作树，也零请求', async () => {
    // 现场形态：归档集合很大，其中历史会话宿主往往已不再持有（/status 永久 isGit: null）。
    const archived = Array.from({ length: 30 }, (_, i) => `archived-${i}`)
    const ids = ['s-0', ...archived]
    const h = harness(() => LOCAL_STATUS, ids, { bindings: bindingsFor(archived), archived })
    await flushMicrotasks()
    for (let i = 0; i < 20; i++) h.publishWorkspaces()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 3)

    expect(h.statusCalls()).toBe(1) // 只有当前会话 s-0 的 isGit 校准
    expect(h.discardCalls()).toBe(0) // 归档会话一次 discard 都没有
    expect(h.bindingsCalls()).toBe(1)
    h.dispose()
  })

  it('仅「本次归档且本端已知是工作树」发一次 discard，不轮询不重放', async () => {
    const h = harness(() => LOCAL_STATUS, ['s-0', 's-a'], { bindings: bindingsFor(['s-a']) })
    await flushMicrotasks()
    expect(h.discardCalls()).toBe(0)

    // 用户点击归档 s-a：本端 store 已知它是工作树会话 → 一次 fire-and-forget discard。
    h.setArchived(['s-a'])
    await flushMicrotasks()
    expect(h.discardCalls()).toBe(1)
    const statusAfterArchive = h.statusCalls()

    // 归档集合反复快照：不重放、不轮询（历史实现对归档会话按 500ms 轮询最多 120 次）。
    for (let i = 0; i < 20; i++) h.publishWorkspaces()
    await vi.advanceTimersByTimeAsync(DISCARD_POLL_DELAY_MS * 10)
    expect(h.discardCalls()).toBe(1)
    expect(h.statusCalls()).toBe(statusAfterArchive)
    h.dispose()
  })

  it('dispose 取消待执行的拖尾复核', async () => {
    const h = harness(() => WORKTREE_STATUS, ['s-0'], { bindings: bindingsFor(['s-0']), runningBit: false })
    await flushMicrotasks()
    // 首次事件经前沿立即执行一次；随后的高频事件合并为窗口末尾的拖尾执行。
    h.emitSessionEvent('s-0')
    expect(h.statusCalls()).toBe(1)
    for (let i = 0; i < 100; i++) h.emitSessionEvent('s-0')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    h.dispose()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 5)
    expect(h.statusCalls()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
