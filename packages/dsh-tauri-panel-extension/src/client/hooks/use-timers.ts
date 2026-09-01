/**
 * hooks/use-timers.ts — 受控定时器集合 + mounted 守卫。
 *
 * 多个 tab（skills / mcp）都需要「组件卸载时清理全部 timer、回调只在仍挂载时
 * 执行」的同一形态；抽成共享 hook，避免每个组件各自维护 `timers.current` +
 * `mounted.current` + 清理 effect。
 */

import type { MutableRefObject } from 'react'
import { useEffect, useRef } from 'react'

export interface TimersController {
  /** 组件是否仍挂载（异步续接守卫；卸载时置 false）。 */
  mounted: MutableRefObject<boolean>
  /** 登记一个 timer；组件卸载时统一清理，且回调只会在仍挂载时触发。 */
  later: (callback: () => void, delay: number) => void
}

/** 创建受控 timer 集合；组件卸载时统一清理并停止后续回调。 */
export function useTimers(): TimersController {
  const timers = useRef<Set<number>>(new Set())
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
    for (const timer of timers.current)
      window.clearTimeout(timer)
    timers.current.clear()
  }, [])
  return {
    mounted,
    later(callback, delay) {
      const timer = window.setTimeout(() => {
        timers.current.delete(timer)
        if (mounted.current)
          callback()
      }, delay)
      timers.current.add(timer)
    },
  }
}
