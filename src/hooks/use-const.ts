import { useRef } from 'react'

/**
 * 在组件整个生命周期中保持值不变
 * 支持直接传值或传入初始化函数
 */
export function useConst<T>(initialValue: T | (() => T)): T {
  const ref = useRef<{ value: T } | null>(null)

  if (ref.current === null) {
    ref.current = {
      value: typeof initialValue === 'function'
        ? (initialValue as () => T)()
        : initialValue,
    }
  }

  return ref.current.value
}
