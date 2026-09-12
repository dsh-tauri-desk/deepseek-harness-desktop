/**
 * hydration.test.ts — registerWorktreeHydration 的请求频率回归测试。
 *
 * 背景（issue 现象）：会话事件流在流式输出期间每秒可通知上百次，列表快照同样随事件
 * 持续变化；两者都触发 /status 复核，于是只读状态查询被放大成「每秒上百次请求」
 * （宿主每次还要 fork 一个 git 子进程）。本用例把事件流/列表快照的触发频率全量拉满，
 * 断言 /status 请求被节流到每窗口至多一次，同时保证拖尾执行不丢状态变化。
 *
 * 通过 vi.mock 替换 dsh-tauri/client：既避免在 node 环境加载客户端 barrel，又把
 * fetch（HTTP 边界）与定时器收敛成可观察的替身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_RECONCILE_MIN_INTERVAL_MS } from '../constants'
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

/** 只排空微任务队列（不推进假时钟），让首次 /status 的 patchSession 落到 store。 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await Promise.resolve()
}

interface Harness {
  dispose: () => void
  emitSessionEvent: () => void
  publishList: () => void
  statusCalls: () => number
}

/** 装配一个「单会话 + 可手动触发事件流/列表快照」的 hydration 环境。 */
function harness(status: Record<string, unknown>): Harness {
  const sessionId = 'session-1'
  const sessionListeners = new Set<() => void>()
  const list = snapshotSource({ ids: [sessionId], current: sessionId })
  const workspaces = snapshotSource({ archivedSessionIds: [] as string[] })

  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/status'))
      return status
    return { ok: true }
  })

  const ctx = {
    sessions: {
      list,
      binding: (id: string) => id === sessionId
        ? {
            session: {
              subscribe: (listener: () => void) => {
                sessionListeners.add(listener)
                return () => sessionListeners.delete(listener)
              },
            },
          }
        : undefined,
      open: () => {},
      refresh: async () => {},
    },
    workspaces: { list: workspaces },
  }

  const dispose = registerWorktreeHydration(ctx as never)
  return {
    dispose,
    emitSessionEvent: () => {
      for (const listener of [...sessionListeners])
        listener()
    },
    publishList: () => list.publish({ ids: [sessionId], current: sessionId }),
    statusCalls: () => mocks.fetch.mock.calls.filter(call => String(call[0]).includes('/status')).length,
  }
}

describe('registerWorktreeHydration /status 请求频率', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('工作树会话：事件风暴合并为窗口末尾的一次复核', async () => {
    const h = harness({ mode: 'worktree', worktreeKey: 'h/d', worktreePath: 'C:/wt', projectPath: 'C:/repo', log: [], isGit: true })
    // 首次 hydrate 立即发一次（前沿语义：不引入启动延迟）。
    expect(h.statusCalls()).toBe(1)
    await flushMicrotasks()

    // 模拟流式输出：一个窗口内 300 次会话事件 + 300 次列表快照。
    for (let i = 0; i < 300; i++) {
      h.emitSessionEvent()
      h.publishList()
    }
    expect(h.statusCalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    expect(h.statusCalls()).toBe(2)

    // 空闲（无事件、无列表变化）时不再有任何请求。
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 5)
    expect(h.statusCalls()).toBe(2)
    h.dispose()
  })

  it('工作树会话：持续 10 个窗口的高频触发只产生 1 次/窗口的请求', async () => {
    const h = harness({ mode: 'worktree', worktreeKey: 'h/d', worktreePath: 'C:/wt', projectPath: 'C:/repo', log: [], isGit: true })
    await flushMicrotasks()
    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 200; i++) {
        h.emitSessionEvent()
        h.publishList()
      }
      await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    }
    // 1 次首次复核 + 每个窗口 1 次拖尾复核（此前是每个事件一次，约 2000 次）。
    expect(h.statusCalls()).toBe(11)
    h.dispose()
  })

  it('事件率提高 10 倍不改变请求数（节流与触发频率解耦）', async () => {
    const h = harness({ mode: 'worktree', worktreeKey: 'h/d', worktreePath: 'C:/wt', projectPath: 'C:/repo', log: [], isGit: true })
    await flushMicrotasks()
    // 每个窗口 2000 次事件 + 2000 次列表快照（≈2000 次/秒，是上一用例的 10 倍）。
    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 2000; i++) {
        h.emitSessionEvent()
        h.publishList()
      }
      await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    }
    // 与低频用例完全一致：请求数只由窗口数决定，与事件率无关。
    expect(h.statusCalls()).toBe(11)
    h.dispose()
  })

  it('本地会话：解析成功后事件/列表变化都不再触发请求', async () => {
    const h = harness({ mode: 'local', projectPath: 'C:/repo', isGit: true })
    expect(h.statusCalls()).toBe(1)
    await flushMicrotasks()

    for (let window = 0; window < 5; window++) {
      for (let i = 0; i < 200; i++) {
        h.emitSessionEvent()
        h.publishList()
      }
      await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS)
    }
    expect(h.statusCalls()).toBe(1)
    h.dispose()
  })

  it('dispose 取消待执行的拖尾复核', async () => {
    const h = harness({ mode: 'worktree', worktreeKey: 'h/d', worktreePath: 'C:/wt', projectPath: 'C:/repo', log: [], isGit: true })
    await flushMicrotasks()
    h.emitSessionEvent()
    // 拖尾任务已排定但尚未执行（请求数仍为首次的那一次）。
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(h.statusCalls()).toBe(1)
    h.dispose()
    await vi.advanceTimersByTimeAsync(SESSION_RECONCILE_MIN_INTERVAL_MS * 5)
    expect(h.statusCalls()).toBe(1)
  })
})
