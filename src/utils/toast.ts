import type { ToastContentValue } from '@heroui/react/toast'
import type { ToastVariants } from '@heroui/styles'
import type { ReactNode } from 'react'
import { emitter } from '@hairy/react-lib'
import { ToastQueue } from '@heroui/react'

/** toast() 可选项：库内未暴露的 HeroUIToastOptions（toast-queue 收敛的 content + 超时回调），这里用公开的 ToastContentValue 组合 */
export type ToastOptions = Partial<ToastContentValue & { timeout?: number, onClose?: () => void }> & { placement?: Placement }
export type ToastUpdateOptions = Partial<ToastContentValue>

export interface ToastUpdateEvent {
  key: string
  options: ToastUpdateOptions
}

/** toast 关闭事件（toast.close / 超时自动关闭）。 */
export interface ToastCloseEvent {
  key: string
}

/** toast 全部清除事件（toast.clear）。 */
export interface ToastClearEvent {
  key?: undefined
}

export const TOAST_CLOSE_EVENT = 'toast.close'
export const TOAST_CLEAR_EVENT = 'toast.clear'

export type Placement = NonNullable<ToastVariants['placement']>
export const placements = [
  'top start',
  'top',
  'top end',
  'bottom start',
  'bottom',
  'bottom end',
] as const

export const queues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: 3 })]),
) as Record<Placement, ToastQueue>

const linuxQueues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: 3, wrapUpdate: fn => fn() })]),
) as Record<Placement, ToastQueue>

export const activeQueues = navigator.platform.toLowerCase().includes('linux')
  ? linuxQueues
  : queues

const toastContents = new Map<string, ToastContentValue>()
const placementsKeys = new Map<string, Placement>()

/**
 * 统一 toast API：直接调用创建，toast.update/close/clear 通过 key 管理。
 * update 触发 emitter 'toast.update'，由 ToastProvider 经 useEventBus 消费后
 * 原地更新对应 queue 的 content（HeroUI ToastQueue 没有 update 方法）。
 */
export const toast = Object.assign(
  (message: string | ReactNode, options?: ToastOptions) => {
    // 默认右下角；个别调用方需要其他位置时显式传 placement
    const { placement = 'bottom end', timeout, onClose, ...rest } = options || {}
    let key = ''
    const content = { title: message, ...rest }
    key = activeQueues[placement].add(content, {
      timeout,
      onClose: () => {
        toastContents.delete(key)
        placementsKeys.delete(key)
        // 超时/显式关闭都可能发生：通知 provider 清理 updates，避免 key 残留
        // 到 provider 卸载（旧 toast 重开 / 内存泄漏）。
        emitter.emit(TOAST_CLOSE_EVENT, { key } satisfies ToastCloseEvent)
        onClose?.()
      },
    })
    toastContents.set(key, content)
    placementsKeys.set(key, placement)
    return key
  },
  {
    update(key: string, options: ToastUpdateOptions): void {
      if (!placementsKeys.has(key))
        return
      toastContents.set(key, { ...(toastContents.get(key) ?? {}), ...options })
      emitter.emit('toast.update', { key, options })
    },

    close(key: string): void {
      const placement = placementsKeys.get(key)
      if (placement)
        activeQueues[placement].close(key)
      else
        toastContents.delete(key)
      emitter.emit(TOAST_CLOSE_EVENT, { key } satisfies ToastCloseEvent)
    },

    clear(): void {
      toastContents.clear()
      placementsKeys.clear()
      placements.forEach(p => activeQueues[p].clear())
      emitter.emit(TOAST_CLEAR_EVENT, {} satisfies ToastClearEvent)
    },
  },
)
