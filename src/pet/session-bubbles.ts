/**
 * session-bubbles.ts — 会话 Toast 的描述 store 与标题/描述纯函数。
 *
 * 会话 Toast 采用「固定标题 + 实时描述」语义（issue #308 bug 3）：
 * - create：会话首次进入进行态时 `toast()` 一次，title 传固定字符串，description
 *   传一个订阅本 store 的 React 元素（见 session-bubble.tsx），此后绝不更换实例；
 * - update：会话描述变化时仅更新 store，React 元素订阅到版本变化后原地重渲染
 *   描述文本，队列层不产生 add/close 反复操作，避免闪烁；
 * - remove：会话离开进行态时由调用方 `toast.close(key)`，并删除 store 条目。
 * 单条推送：每个会话独立一份描述与实例，多条会话互不合并。
 */

export interface SessionBubbleInput {
  activity?: unknown
  bubble?: unknown
  description?: unknown
}

export interface SessionBubbleStore {
  get: (id: string) => string | undefined
  set: (id: string, description: string) => void
  delete: (id: string) => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => number
}

export function createSessionBubbleStore(): SessionBubbleStore {
  const descriptions = new Map<string, string>()
  const listeners = new Set<() => void>()
  let version = 0

  function emit() {
    version += 1
    for (const listener of [...listeners])
      listener()
  }

  return {
    get(id) {
      return descriptions.get(id)
    },
    set(id, description) {
      if (descriptions.get(id) === description)
        return
      descriptions.set(id, description)
      emit()
    },
    delete(id) {
      if (!descriptions.has(id))
        return
      descriptions.delete(id)
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return version
    },
  }
}

/** 全局单例：pet WebView 内所有会话 Toast 共享同一份描述状态。 */
export const sessionBubbleStore = createSessionBubbleStore()

export function normalizeToastMessage(value: unknown): string {
  if (typeof value === 'string')
    return value.trim()
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string')
    return value.text.trim()
  return ''
}

/** 会话固定标题：优先气泡（会话名），缺省回落动作名。 */
export function sessionBubbleTitle(session: SessionBubbleInput): string {
  const state = typeof session.activity === 'string' && session.activity !== 'idle'
    ? session.activity
    : 'working'
  return normalizeToastMessage(session.bubble) || state
}

/** 会话实时描述：优先描述字段，缺省回落标题。 */
export function sessionBubbleDescription(session: SessionBubbleInput): string {
  return normalizeToastMessage(session.description) || sessionBubbleTitle(session)
}
