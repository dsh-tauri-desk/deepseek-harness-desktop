import type { ToastContentValue } from '@heroui/react/toast'
import type { ToastVariants } from '@heroui/styles'
import type { ReactNode } from 'react'
import { ToastQueue } from '@heroui/react'
import { hooks } from '@/config/hooks'

/** toast() 可选项：库内未暴露的 HeroUIToastOptions（toast-queue 收敛的 content + 超时回调），这里用公开的 ToastContentValue 组合 */
export type ToastOptions = Partial<ToastContentValue & { timeout?: number, onClose?: () => void }> & { placement?: Placement }
export type ToastUpdateOptions = Partial<ToastContentValue>

export type Placement = NonNullable<ToastVariants['placement']>
export const placements = [
  'top start',
  'top',
  'top end',
  'bottom start',
  'bottom',
  'bottom end',
] as const

/**
 * 单个 placement 同时存在的 toast 上限：渲染层（maxVisibleToasts）与丢弃层
 * （placementKeys 超限关最旧）共用同一数值。
 */
const MAX_VISIBLE_TOASTS = 3

export const queues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: MAX_VISIBLE_TOASTS })]),
) as Record<Placement, ToastQueue>

const linuxQueues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: MAX_VISIBLE_TOASTS, wrapUpdate: fn => fn() })]),
) as Record<Placement, ToastQueue>

export const activeQueues = navigator.platform.toLowerCase().includes('linux')
  ? linuxQueues
  : queues

const toastContents = new Map<string, ToastContentValue>()
const placementsKeys = new Map<string, Placement>()
/**
 * 每个 placement 的存活 key（按创建顺序，旧→新）。stately queue 对超出
 * maxVisibleToasts 的条目只做「窗口外排队、等旧条目关闭后复现」，常驻
 * （timeout: 0）气泡会无限积压并在旧气泡关闭时复现；这里在新 toast 入队后
 * 直接关闭最旧的条目，保证任何时刻只存在最新的 MAX_VISIBLE_TOASTS 条。
 */
const placementOrder = new Map<Placement, string[]>()

function forgetKey(key: string): void {
  toastContents.delete(key)
  const placement = placementsKeys.get(key)
  placementsKeys.delete(key)
  if (placement === undefined)
    return
  const order = placementOrder.get(placement)
  if (order === undefined)
    return
  const index = order.indexOf(key)
  if (index >= 0)
    order.splice(index, 1)
  if (order.length === 0)
    placementOrder.delete(placement)
}

/**
 * 统一 toast API：直接调用创建，toast.update/close/clear 通过 key 管理。
 * update 触发 `hooks['toast.updated']` 事件（见 config/hooks），由 ToastProvider 消费后
 * 原地更新对应 queue 的 content（HeroUI ToastQueue 没有 update 方法）。
 */
export const toast = Object.assign(
  (message: string | ReactNode, options?: ToastOptions) => {
    // 默认右下角；个别调用方需要其他位置时显式传 placement
    const { placement = 'bottom end', timeout, onClose, ...rest } = options || {}
    const content = { title: message, ...rest }
    const key = activeQueues[placement].add(content, {
      timeout,
      onClose: () => {
        // 自动超时 / 用户关闭 / 外部 close 都会走到这里；延后业务回调，避免渲染中更新组件。
        forgetKey(key)
        queueMicrotask(() => onClose?.())
      },
    })
    toastContents.set(key, content)
    placementsKeys.set(key, placement)
    const order = placementOrder.get(placement) ?? []
    order.push(key)
    placementOrder.set(placement, order)
    // 丢弃超出上限的最旧条目（含 rAF 清理延迟期内的死 key），维持「仅最新 N 条」
    while (order.length > MAX_VISIBLE_TOASTS) {
      const oldest = order.shift()
      if (oldest !== undefined)
        activeQueues[placement].close(oldest)
    }
    return key
  },
  {
    update(key: string, options: ToastUpdateOptions): void {
      if (!placementsKeys.has(key))
        return
      toastContents.set(key, { ...(toastContents.get(key) ?? {}), ...options })
      void hooks['toast.updated'].trigger({ key, options })
    },

    close(key: string): void {
      const placement = placementsKeys.get(key)
      if (placement) {
        activeQueues[placement].close(key)
        // onClose 是 rAF 异步回调，这里同步清理登记，紧随其后的 add 不会把死 key 计入限额
        forgetKey(key)
      }
      else {
        toastContents.delete(key)
      }
    },

    clear(): void {
      toastContents.clear()
      placementsKeys.clear()
      placementOrder.clear()
      placements.forEach(p => activeQueues[p].clear())
    },
  },
)
