/**
 * host/utils/queue.test.ts — 工作区级串行队列。
 *
 * 这里守的是「同一工作区的私有仓操作绝不并发」这条不变量：index 与 refs 是共享可变状态，
 * 并发就会撞 `index.lock`。另外两条同样重要：不同工作区必须互不阻塞；队尾必须在结算后出队
 * （否则长期运行的 Host 每见一个工作区就常驻一条 Promise，无界增长）。
 */

import { describe, expect, it } from 'vitest'
import { createWorkspaceQueue } from './queue'

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('createWorkspaceQueue', () => {
  it('同一工作区的任务严格 FIFO，绝不重叠', async () => {
    const queue = createWorkspaceQueue()
    const events: string[] = []
    let inFlight = 0

    const task = (name: string, delay: number) => async (): Promise<string> => {
      inFlight += 1
      expect(inFlight).toBe(1)
      events.push(`${name}:start`)
      await tick(delay)
      events.push(`${name}:end`)
      inFlight -= 1
      return name
    }

    // 故意让先入队者更慢：若没有串行化，`b:start` 会插到 `a:end` 前面。
    const first = queue.run('ws', task('a', 20))
    const second = queue.run('ws', task('b', 1))
    const third = queue.run('ws', task('c', 1))

    expect(await Promise.all([first, second, third])).toEqual(['a', 'b', 'c'])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('不同工作区互不阻塞', async () => {
    const queue = createWorkspaceQueue()
    const order: string[] = []
    const slow = queue.run('ws-a', async () => {
      order.push('a:start')
      await tick(20)
      order.push('a:end')
    })
    const fast = queue.run('ws-b', async () => {
      order.push('b:start')
      await tick(1)
      order.push('b:end')
    })
    await Promise.all([slow, fast])
    // b 不必等 a 的 20ms。
    expect(order.indexOf('b:end')).toBeLessThan(order.indexOf('a:end'))
  })

  it('前一个任务失败不阻断后续排队者，且错误原样透出', async () => {
    const queue = createWorkspaceQueue()
    const failing = queue.run('ws', async () => {
      throw new Error('捕获失败')
    })
    const following = queue.run('ws', async () => 'ok')
    await expect(failing).rejects.toThrow('捕获失败')
    await expect(following).resolves.toBe('ok')
  })

  it('结算后队尾出队；不同工作区各自的队尾共享同一张表', async () => {
    const queue = createWorkspaceQueue()
    expect(queue.size()).toBe(0)
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = queue.run('ws-a', async () => {
      await gate
      return 1
    })
    queue.run('ws-b', async () => 2)
    // 队尾表在任务在飞时持有 2 条（a 卡在 gate 上，b 已结算并出队）。
    await tick(5)
    expect(queue.size()).toBe(1)

    const queuedBehind = queue.run('ws-a', async () => 3)
    expect(queue.size()).toBe(1)

    release()
    await expect(pending).resolves.toBe(1)
    await expect(queuedBehind).resolves.toBe(3)
    await tick(5)
    // 全部结算后必须归零：常驻队尾就是泄漏。
    expect(queue.size()).toBe(0)
  })

  it('任务返回值与队列诊断互不干扰', async () => {
    interface Payload { ok: boolean }
    const queue = createWorkspaceQueue()
    const value: Payload = await queue.run('ws', async () => ({ ok: true }))
    expect(value).toEqual({ ok: true })
    await tick(5)
    expect(queue.size()).toBe(0)
  })
})
