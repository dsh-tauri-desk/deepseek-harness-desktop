/**
 * client/components/turn-changes-card.utils.test.ts — 卡片两处点击决策的判据与静默边界。
 *
 * 合并自 `client/utils/open-file.test.ts` 与 `client/utils/review.test.ts`（纯函数已迁到
 * `turn-changes-card.utils.ts`）。核心断言：
 * **旧内核（无侧边栏能力）即使拿到了 `openFile` 也绝不能被调用**；
 * **旧内核（没有 sidebarRight）不显示「审核」按钮**；
 * **文件树页类型缺席时也不显示按钮**（否则 `openTab('files')` 必然抛
 * `no tab type is registered`，等于给一个点了没反应的假交互）。
 */

import { describe, expect, it, vi } from 'vitest'
import { fileOpenHandler, reviewOpenHandler } from './turn-changes-card.utils'

describe('fileOpenHandler', () => {
  it('新内核（有侧边栏能力 + 有 openFile）→ 返回可点处理器', () => {
    const openFile = vi.fn()
    const handler = fileOpenHandler({ openFile, sidebarPreview: true })
    expect(handler).toBeTypeOf('function')
    handler?.('src/a.ts')
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('旧内核（有 openFile 但无侧边栏能力）→ 不可点，且**一个字节都不调用**', () => {
    const openFile = vi.fn()
    expect(fileOpenHandler({ openFile, sidebarPreview: false })).toBeUndefined()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('框架没派发 openFile → 不可点', () => {
    expect(fileOpenHandler({ sidebarPreview: true })).toBeUndefined()
    expect(fileOpenHandler({ openFile: undefined, sidebarPreview: true })).toBeUndefined()
  })

  it('openFile 不是函数（壳提供了脏字段）→ 不可点', () => {
    expect(fileOpenHandler({ openFile: 'open' as never, sidebarPreview: true })).toBeUndefined()
  })

  it('openFile 返回 rejected promise → 静默吞掉，不产生未处理 rejection', async () => {
    const handler = fileOpenHandler({
      openFile: () => Promise.reject(new Error('path open failed')),
      sidebarPreview: true,
    })
    expect(handler).toBeTypeOf('function')
    handler?.('src/a.ts')
    // 让微任务队列跑完：若有未处理 rejection，vitest 会在这里报出来。
    await Promise.resolve()
    await Promise.resolve()
  })

  it('openFile 同步抛错 → 静默吞掉（卡片没有错误面，打开失败不该打断会话）', () => {
    const handler = fileOpenHandler({
      openFile: () => {
        throw new Error('boom')
      },
      sidebarPreview: true,
    })
    expect(() => handler?.('src/a.ts')).not.toThrow()
  })

  it('路径原样透传（相对路径由框架按会话 cwd 解析）', () => {
    const openFile = vi.fn()
    const handler = fileOpenHandler({ openFile, sidebarPreview: true })
    handler?.('packages/a/b.ts')
    handler?.('C:\\Other\\file.txt')
    expect(openFile.mock.calls).toEqual([['packages/a/b.ts'], ['C:\\Other\\file.txt']])
  })
})

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
