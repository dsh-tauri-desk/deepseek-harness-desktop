/**
 * throttle.test.ts — createKeyedThrottle 单测。
 *
 * 注入假时钟与假调度器在 node 环境确定性地验证节流语义：前沿立即执行、窗口内合并为
 * 一次拖尾执行、窗口结束后恢复立即执行、key 之间互不影响、cancel/clear 清理定时器。
 */
import { describe, expect, it } from 'vitest'
import { createKeyedThrottle } from './throttle'

/** 假时钟 + 假调度器：advance 推进时间并按到期顺序触发已排定的任务。 */
function harness(intervalMs: number) {
  let time = 0
  let timers: { at: number, fn: () => void }[] = []
  const throttle = createKeyedThrottle({
    intervalMs,
    now: () => time,
    schedule: (fn, ms) => {
      const timer = { at: time + ms, fn }
      timers.push(timer)
      return () => {
        timers = timers.filter(item => item !== timer)
      }
    },
  })
  return {
    throttle,
    now: () => time,
    pendingTimers: () => timers.length,
    advance(ms: number): void {
      time += ms
      const due = timers.filter(timer => timer.at <= time).sort((a, b) => a.at - b.at)
      for (const timer of due) {
        timers = timers.filter(item => item !== timer)
        timer.fn()
      }
    },
  }
}

describe('createKeyedThrottle', () => {
  it('首次请求立即执行', () => {
    const h = harness(1000)
    let runs = 0
    h.throttle.request('s1', () => {
      runs += 1
    })
    expect(runs).toBe(1)
    expect(h.pendingTimers()).toBe(0)
  })

  it('窗口内的高频请求合并为窗口末尾的一次拖尾执行', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    // 模拟流式输出期间的上百次通知：全部落在同一节流窗口内。
    for (let i = 0; i < 100; i++) {
      h.advance(1)
      h.throttle.request('s1', run)
    }
    expect(runs).toBe(1)
    h.advance(1000)
    expect(runs).toBe(2)
    // 拖尾执行后窗口重新计时，不产生额外执行。
    h.advance(1000)
    expect(runs).toBe(2)
  })

  it('间隔已满时立即执行，不排定拖尾任务', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    h.advance(1000)
    h.throttle.request('s1', run)
    expect(runs).toBe(2)
    expect(h.pendingTimers()).toBe(0)
  })

  it('持续高频请求下执行频率收敛到每窗口至多一次', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    // 10s 内每 10ms 请求一次（共 1000 次）：1 次立即执行 + 每个窗口末尾 1 次拖尾
    // （t=1000…10000 各一次）。
    for (let i = 0; i < 1000; i++) {
      h.throttle.request('s1', run)
      h.advance(10)
    }
    expect(runs).toBe(11)
  })

  it('不同 key 各自独立计时', () => {
    const h = harness(1000)
    const runs: string[] = []
    h.throttle.request('s1', () => runs.push('s1'))
    h.throttle.request('s2', () => runs.push('s2'))
    expect(runs).toEqual(['s1', 's2'])
  })

  it('cancel 取消待执行的拖尾任务并重置窗口', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    h.advance(200)
    h.throttle.request('s1', run)
    h.throttle.cancel('s1')
    expect(h.pendingTimers()).toBe(0)
    h.advance(5000)
    expect(runs).toBe(1)
    // 取消后视为全新 key：下一次请求立即执行。
    h.throttle.request('s1', run)
    expect(runs).toBe(2)
  })

  it('clear 清空全部 key 的待执行任务', () => {
    const h = harness(1000)
    let runs = 0
    const run = (): void => {
      runs += 1
    }
    h.throttle.request('s1', run)
    h.throttle.request('s2', run)
    h.throttle.request('s1', run)
    h.throttle.request('s2', run)
    expect(h.pendingTimers()).toBe(2)
    h.throttle.clear()
    expect(h.pendingTimers()).toBe(0)
    h.advance(5000)
    expect(runs).toBe(2)
  })
})
