/**
 * controller.test.ts — 会话区替换控制器的槽位注册回归。
 *
 * 核心 0.1.5-rc.1 把会话区并入 keyed 槽 `main`（cell key `conversation`），旧
 * `conversation` 单槽消失：只 inject 旧槽时声明永不出现 → 内容区不替换，只剩
 * 侧栏条目选中样式。控制器必须同时 inject 两个版本候选。
 */

import type { ClientContext } from 'dsh-tauri/client'
import type { PanelContentSpec } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_VIEW_COMPONENT_ID } from '../constants'
import { createPanelConversationController } from './controller'

// dsh-tauri 的 dist bundle 以 `window.__ModuleLoader__.load(...)` 包裹，脱离宿主
// 加载器后无法在 node 环境求值；只 mock 控制器实际消费的三个工厂。
vi.mock('dsh-tauri/client', () => ({
  createExternalStore: <T>(initial: T) => {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      set: (next: T | ((current: T) => T)) => {
        const value = typeof next === 'function' ? (next as (current: T) => T)(state) : next
        if (Object.is(value, state))
          return
        state = value
        for (const listener of [...listeners])
          listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  },
  createHooks: () => ({ callHook: vi.fn(() => Promise.resolve()) }),
  createLifecycleController: () => ({
    add: vi.fn(),
    dispose: vi.fn(),
    isDisposed: () => false,
  }),
}))

// conversation-seat.cssr / conversation-seat.tsx 依赖 dsh-tauri-ui/client 的
// cssr 实例与 useMountStyle；测试不渲染组件，给最小桩件即可。
vi.mock('dsh-tauri-ui/client', () => {
  const node = { mount: () => {}, render: () => '', unmount: () => {} }
  const chain = (): unknown => node
  return {
    cssr: { bem: { b: chain, e: chain, m: chain }, c: chain },
    mountStyle: () => () => {},
    useMountStyle: () => {},
  }
})

interface RegisteredEntry {
  component: unknown
  options: Record<string, unknown>
}

interface SlotsStub {
  ctx: ClientContext
  injected: string[]
  registerDisposers: Array<ReturnType<typeof vi.fn>>
  registered: RegisteredEntry[]
}

/** 记录 inject/register 调用的最小 slots 服务桩件（register 返回独立 disposer）。 */
function createSlotsStub(): SlotsStub {
  const injected: string[] = []
  const registered: RegisteredEntry[] = []
  const registerDisposers: Array<ReturnType<typeof vi.fn>> = []
  const slots = {
    inject: (slot: string, setup: () => unknown) => {
      injected.push(slot)
      const dispose = setup()
      return () => {
        if (typeof dispose === 'function')
          (dispose as () => void)()
      }
    },
    register: (options: unknown, component: unknown) => {
      registered.push({ component, options: options as Record<string, unknown> })
      const dispose = vi.fn()
      registerDisposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx: { slots } as unknown as ClientContext,
    injected,
    registerDisposers,
    registered,
  }
}

function spec(id: string, locale?: string): PanelContentSpec {
  return { id, locale, render: () => null }
}

beforeEach(() => {
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    removeEventListener: vi.fn(),
  })
})

describe('createPanelConversationController 会话区替换槽位（0.1.5 回归）', () => {
  it('open 同时 inject 旧 conversation 单槽与 0.1.5 的 main keyed 槽', () => {
    const slots = createSlotsStub()
    const controller = createPanelConversationController()

    controller.toggle(slots.ctx, spec('demo', 'panel-x'))

    expect(slots.injected).toEqual(['conversation', 'main'])
    expect(slots.registered).toHaveLength(2)
    expect(slots.registered[0].options).toMatchObject({
      id: PANEL_VIEW_COMPONENT_ID,
      locale: 'panel-x',
      name: 'conversation',
      priority: -1,
    })
    expect(slots.registered[1].options).toMatchObject({
      key: 'conversation',
      locale: 'panel-x',
      name: 'main',
      priority: -1,
    })
    // keyed 槽不能带 single 槽的 id（两种 shape 各自独立）
    expect(slots.registered[1].options.id).toBeUndefined()
  })

  it('未声明 locale 时回退宿主 panel 命名空间', () => {
    const slots = createSlotsStub()
    const controller = createPanelConversationController()

    controller.toggle(slots.ctx, spec('demo'))

    for (const entry of slots.registered)
      expect(entry.options.locale).toBe('panel')
  })

  it('同 id 再 toggle 关闭：释放两个候选的注册并清空 viewId', () => {
    const slots = createSlotsStub()
    const controller = createPanelConversationController()
    const content = spec('demo')

    controller.toggle(slots.ctx, content)
    expect(controller.viewId()).toEqual({ id: 'demo' })

    controller.toggle(slots.ctx, content)
    expect(controller.viewId()).toBeNull()
    for (const dispose of slots.registerDisposers)
      expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('切换不同 id：先释放旧候选，再为新 id 重新注册两个候选', () => {
    const slots = createSlotsStub()
    const controller = createPanelConversationController()

    controller.toggle(slots.ctx, spec('alpha'))
    expect(slots.registered).toHaveLength(2)

    controller.toggle(slots.ctx, spec('beta'))
    expect(slots.injected).toEqual(['conversation', 'main', 'conversation', 'main'])
    expect(slots.registered).toHaveLength(4)
    // 旧 alpha 的两个候选被释放；新 beta 的两个仍存活（等 close 释放）。
    expect(slots.registerDisposers.map(dispose => dispose.mock.calls.length)).toEqual([1, 1, 0, 0])
    expect(controller.viewId()).toEqual({ id: 'beta' })
  })
})
