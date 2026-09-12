import type { ToastContentValue } from '@heroui/react/toast'
import { createEventHook } from '@reause/core'

/**
 * 壳层瞬时事件总线（reause `createEventHook`）。
 *
 * 只承载「无状态、可能跨 store 触发」的瞬时通知；跨组件状态一律走 valtio-define
 * store，不要往这里加新的全局状态。
 *
 * 消费端统一用 reause `useListener` 绑定，卸载自动注销：
 * ```tsx
 * useListener(hooks['toast.updated'].on, (event) => { ... })
 * ```
 */

/** toast 内容原地更新（HeroUI ToastQueue 没有 update 方法，由 ToastProvider 消费后重渲染） */
export interface ToastUpdateEvent {
  key: string
  options: Partial<ToastContentValue>
}

export const hooks = {
  /** `toast.update()` 触发，`ToastProvider` 监听后原地更新对应 queue 的 content */
  'toast.updated': createEventHook<ToastUpdateEvent>(),
  /** 请求关闭设置对话框（harness / preinstall store 在服务重启、退出前收起弹层） */
  'config.dialog.hidden': createEventHook<void>(),
}
