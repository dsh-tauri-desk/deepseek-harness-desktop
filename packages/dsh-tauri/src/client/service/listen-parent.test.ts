/**
 * service/listen-parent.test.ts — 父窗口消息入口的边界测试。
 *
 * 覆盖：只认 `event.source === window.parent`、非法 data 丢弃、`types` 过滤（字符串与**数组**
 * ——数组曾被误判成 handler 导致过滤静默失效）、handler 收到已校验的 context、unlisten 注销。
 *
 * 仓库未装 jsdom（根 vitest 默认 node 环境），用 `vi.stubGlobal('window', …)` 提供最小假实现。
 */
import type { ParentMessage } from '../types/iframe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenParent } from './listen-parent'

/** 假 window：只实现 message 监听表；返回派发器与存活监听数。 */
function stubWindow(): {
  parent: object
  sibling: object
  dispatch: (source: unknown, data: unknown) => void
  listenerCount: () => number
} {
  const parent = { name: 'parent' }
  const sibling = { name: 'sibling' }
  const listeners = new Set<(event: MessageEvent) => void>()

  vi.stubGlobal('window', {
    parent,
    addEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
      listeners.add(handler)
    },
    removeEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
      listeners.delete(handler)
    },
  })

  return {
    parent,
    sibling,
    dispatch: (source, data) => {
      for (const handler of [...listeners])
        handler({ source, data } as unknown as MessageEvent)
    },
    listenerCount: () => listeners.size,
  }
}

/** 等价的假消息（`ParentMessage` 的 type + 自定义字段）。 */
function message(type: string): ParentMessage {
  return { type, payload: type }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listenParent', () => {
  it('只收直接父窗口的消息，兄弟窗口与非法 data 一律丢弃', () => {
    const { parent, sibling, dispatch } = stubWindow()
    const seen: ParentMessage[] = []
    listenParent<ParentMessage>(received => seen.push(received))

    dispatch(parent, message('dsh://demo'))
    expect(seen).toEqual([message('dsh://demo')])

    // 兄弟 iframe / 页面内第三方脚本伪造不了 source
    dispatch(sibling, message('dsh://demo'))
    dispatch(undefined, message('dsh://demo'))
    expect(seen).toHaveLength(1)

    dispatch(parent, null)
    dispatch(parent, 'raw-string')
    dispatch(parent, 42)
    expect(seen).toHaveLength(1)
  })

  it('types 过滤支持字符串与数组（数组不能被当成 handler）', () => {
    const { parent, dispatch } = stubWindow()
    const single: string[] = []
    const many: string[] = []
    listenParent<ParentMessage>(received => single.push(received.type ?? ''), 'dsh://a')
    listenParent<ParentMessage>(received => many.push(received.type ?? ''), ['dsh://a', 'dsh://b'])

    dispatch(parent, message('dsh://a'))
    dispatch(parent, message('dsh://b'))
    dispatch(parent, message('dsh://c'))

    expect(single).toEqual(['dsh://a'])
    expect(many).toEqual(['dsh://a', 'dsh://b'])
  })

  it('handler 收到已校验的 context（保留原始 message 事件）', () => {
    const { parent, dispatch } = stubWindow()
    const contexts: unknown[] = []
    listenParent<ParentMessage>((_received, context) => contexts.push(context))

    const event = { source: parent, data: message('dsh://demo') } as unknown as MessageEvent
    dispatch(parent, event.data)
    // 派发器构造新事件对象，context.event 必须就是本次事件本身（不是消息体）
    expect(contexts).toHaveLength(1)
    expect((contexts[0] as { event: MessageEvent }).event.data).toEqual(message('dsh://demo'))
    expect(event).toBeTypeOf('object')
  })

  it('unlisten 注销监听且重复调用安全', () => {
    const { parent, dispatch, listenerCount } = stubWindow()
    const seen: ParentMessage[] = []
    const unlisten = listenParent<ParentMessage>(received => seen.push(received))

    expect(listenerCount()).toBe(1)
    unlisten()
    expect(listenerCount()).toBe(0)

    dispatch(parent, message('dsh://demo'))
    expect(seen).toEqual([])
    expect(() => unlisten()).not.toThrow()
  })
})
