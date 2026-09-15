import type { MutableRefObject } from 'react'
import { useEffect, useRef } from 'react'

export interface TimersController {
  mounted: MutableRefObject<boolean>
  later: (callback: () => void, delay: number) => void
}

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
