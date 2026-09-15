import type { InvokeBridgeReply } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INVOKE_TIMEOUT_MS,
  PLUGIN_ID,
  SRC_INVOKE_REPLY,
  TYPE_INVOKE_REPLY,
} from '../constants'
import { invoke } from './invoke'

/**
 * 构造一个最小的 window 替身：parent 作为宿主接收 postMessage，按类型独立收集
 * 'message' 监听器并允许测试手动分发一次宿主应答。invoke.ts 只依赖
 * window.parent / window.addEventListener / window.removeEventListener。
 */
function makeWindow() {
  const windowListeners = new Set<(event: MessageEvent<unknown>) => void>()
  const parent = {
    postMessage: vi.fn(),
  }
  const win = {
    parent,
    addEventListener: vi.fn((type: string, fn: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message')
        windowListeners.add(fn)
    }),
    removeEventListener: vi.fn((type: string, fn: (event: MessageEvent<unknown>) => void) => {
      if (type === 'message')
        windowListeners.delete(fn)
    }),
    // 模拟宿主回传：source 必须严格 === window.parent 才能通过 onMessage 的过滤
    dispatchReply(reply: InvokeBridgeReply) {
      for (const listener of [...windowListeners])
        listener({ source: parent, data: reply } as unknown as MessageEvent<unknown>)
    },
  }
  return { win, parent, dispatchReply: win.dispatchReply }
}

describe('dsh-tauri invoke', () => {
  let win: ReturnType<typeof makeWindow>['win']
  let parent: ReturnType<typeof makeWindow>['parent']
  let dispatchReply: ReturnType<typeof makeWindow>['dispatchReply']

  beforeEach(() => {
    vi.useFakeTimers()
    win = makeWindow().win
    parent = win.parent
    dispatchReply = win.dispatchReply
    vi.stubGlobal('window', win)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function postedRequest() {
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    return parent.postMessage.mock.calls[0][0] as Record<string, unknown>
  }

  it('成功应答时 resolve，并立刻清理超时计时器', async () => {
    const promise = invoke<{ enabled: boolean }>('get_pet_status', { a: 1 })
    // postMessage 发出请求，且只留有这一个超时计时器（正是要清理的目标）
    expect(vi.getTimerCount()).toBe(1)
    const request = postedRequest()
    expect(request.source).toBe('dsh-tauri-invoke')
    expect(request.type).toBe('dsh://tauri:invoke')
    expect(request.cmd).toBe('get_pet_status')
    expect(typeof request.nonce).toBe('string')
    expect(request.nonce).toMatch(new RegExp(`^${PLUGIN_ID}:\\d+$`))

    dispatchReply({ source: SRC_INVOKE_REPLY, type: TYPE_INVOKE_REPLY, nonce: request.nonce as string, ok: true, value: { enabled: true } })

    await expect(promise).resolves.toEqual({ enabled: true })
    // 修复点：成功路径也必须 clearTimeout，否则计时器休眠 15s 仍存活（泄漏）
    expect(vi.getTimerCount()).toBe(0)
  })

  it('错误应答时 reject，并清理超时计时器与监听器', async () => {
    const promise = invoke('set_pet_enabled', { enabled: true })
    const request = postedRequest()
    expect(vi.getTimerCount()).toBe(1)

    dispatchReply({ source: SRC_INVOKE_REPLY, type: TYPE_INVOKE_REPLY, nonce: request.nonce as string, ok: false, error: 'boom' })

    await expect(promise).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
    // 监听器已从 window 移除（宿主回传的 listener 不应残留）
    dispatchReply({ source: SRC_INVOKE_REPLY, type: TYPE_INVOKE_REPLY, nonce: request.nonce as string, ok: true, value: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('宿主 15s 未应答时超时 reject，且无残留计时器', async () => {
    const promise = invoke('get_pet_status')
    postedRequest()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(INVOKE_TIMEOUT_MS)

    await expect(promise).rejects.toThrow('NODE_NOT_ANSWERED: invoke get_pet_status timed out')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('postMessage 抛错时 reject，并清理超时计时器与监听器', async () => {
    parent.postMessage.mockImplementation(() => {
      throw new Error('DataCloneError: stored value cannot be cloned')
    })
    const promise = invoke('get_pet_status', { session: { loop: true } })
    // postMessage 抛错时不应发出任何东西，计时器也必须被清除
    await expect(promise).rejects.toThrow('DataCloneError')
    expect(vi.getTimerCount()).toBe(0)
  })
})
