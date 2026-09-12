import type { Motion } from 'dsh-pet-component'
import type { BubbleTracker } from '../utils/bubble-tracker'
import { useUnmount } from '@reause/core'
import { useRef, useState } from 'react'
import { useListen } from '@/hooks/use-listen'
import { createBubbleTracker } from '../utils/bubble-tracker'

export type { BubbleSession } from '../utils/bubble-tracker'

export interface BubbleHandle {
  /**
   * 多会话聚合出的动作档位（`dsh-pet-component` 的 14 个 Motion 之一）；
   * `undefined` = 无会话需要展示（调用方 `pet.clear()` 回落待机）。
   */
  readonly motion: Motion | undefined
}

/**
 * 桌宠窗口的会话气泡：只做两件事——
 * 1. 用 `useListen` 订阅 DSH 推来的三个会话事件，把载荷喂给状态机；
 * 2. 卸载时释放状态机里的定时器与 toast。
 *
 * 会话 → toast 映射、聚合优先级、合并窗口、沉淀与脉冲 TTL 等全部逻辑在
 * `pet/utils/bubble-tracker.ts`（不依赖 React，可单独推理）。
 */
export function useBubble(): BubbleHandle {
  const [motion, setMotion] = useState<Motion | undefined>(undefined)
  // 每个 hook 实例一台状态机：ref 惰性创建，StrictMode 的重复渲染不会重建
  const trackerRef = useRef<BubbleTracker | null>(null)
  trackerRef.current ??= createBubbleTracker(setMotion)
  const tracker = trackerRef.current

  useListen('session:create', event => tracker.apply(event.payload, 'create'))
  useListen('session:update', event => tracker.apply(event.payload, 'update'))
  useListen('session:remove', event => tracker.apply(event.payload, 'remove'))
  useUnmount(() => tracker.dispose())

  return { motion }
}
