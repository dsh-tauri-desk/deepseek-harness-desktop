/**
 * client/utils/review.test.ts — 「审核」按钮的决策与静默边界。
 *
 * 核心断言两条：**旧内核（没有 sidebarRight）不显示按钮**；
 * **文件树页类型缺席时也不显示按钮**（否则 `openTab('files')` 必然抛
 * `no tab type is registered`，等于给一个点了没反应的假交互）。
 */

import { describe, expect, it, vi } from 'vitest'
import { reviewOpenHandler } from './review'

describe('reviewOpenHandler', () => {
  it('新内核（有控制器 + 有文件树页类型）→ 返回可点处理器，并打开文件树', () => {
    const openTab = vi.fn()
    const handler = reviewOpenHandler({ sidebar: { openTab }, fileTree: true, kind: 'files' })
    expect(handler).toBeTypeOf('function')
    handler?.()
    expect(openTab).toHaveBeenCalledWith('files')
  })

  it('旧内核（没有 sidebarRight）→ 不显示按钮', () => {
    expect(reviewOpenHandler({ sidebar: undefined, fileTree: false, kind: 'files' })).toBeUndefined()
  })

  it('控制器没有 openTab（契约漂移 / 脏字段）→ 不显示按钮', () => {
    expect(reviewOpenHandler({ sidebar: {}, fileTree: true, kind: 'files' })).toBeUndefined()
    expect(reviewOpenHandler({ sidebar: { openTab: 'open' as never }, fileTree: true, kind: 'files' })).toBeUndefined()
  })

  it('文件树页类型缺席 → 不显示按钮，且一个字节都不调用', () => {
    const openTab = vi.fn()
    expect(reviewOpenHandler({ sidebar: { openTab }, fileTree: false, kind: 'files' })).toBeUndefined()
    expect(openTab).not.toHaveBeenCalled()
  })

  it('控制器方法收到绑定的 `this`（其内部 require()/注册表都要实例）', () => {
    const face = {
      calls: 0,
      openTab(this: { calls: number }): void {
        this.calls += 1
      },
    }
    const handler = reviewOpenHandler({ sidebar: face as never, fileTree: true, kind: 'files' })
    handler?.()
    expect(face.calls).toBe(1)
  })

  it('打开失败（同步抛错 / rejected promise）静默，不冒泡（无挂载会话面时不打断会话）', async () => {
    const throwing = reviewOpenHandler({
      sidebar: {
        openTab: () => {
          throw new Error('sidebarRight: no mounted session surface')
        },
      },
      fileTree: true,
      kind: 'files',
    })
    expect(() => throwing?.()).not.toThrow()

    const rejecting = reviewOpenHandler({
      sidebar: { openTab: () => Promise.reject(new Error('boom')) },
      fileTree: true,
      kind: 'files',
    })
    expect(() => rejecting?.()).not.toThrow()
    // 让微任务队列跑完：若有未处理 rejection，vitest 会在这里报出来。
    await Promise.resolve()
    await Promise.resolve()
  })
})
