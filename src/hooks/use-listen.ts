import type { EventCallback, Options, UnlistenFn } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef } from 'react'

/**
 * 订阅 Tauri 事件并在卸载时自动注销（`listen` + 卸载清理的壳层统一入口）。
 *
 * 语义对齐 reause 的 `useEventListener`：
 * - 回调与 options 在渲染期写入 ref（与 reause 同款「latest ref」写法），
 *   调用方传内联函数不会反复重订阅，只在 `event` 变化时重新订阅；
 * - 竞态防护：`listen` 是异步的，若在 resolve 前组件已卸载则立即注销，避免监听泄漏。
 *
 * 唯一的 effect 只负责注册/注销监听（需要清理），无其它副作用。
 * `listen` 失败（如非 Tauri 环境）只记录日志，不打断调用方。
 */
export function useListen<T>(event: string, handler: EventCallback<T>, options?: Options): void {
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)
  handlerRef.current = handler
  optionsRef.current = options

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let disposed = false

    void listen<T>(event, payload => handlerRef.current(payload), optionsRef.current)
      .then((fn) => {
        if (disposed)
          fn()
        else
          unlisten = fn
      })
      .catch(err => console.error(`[useListen] failed to listen ${event}:`, err))

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [event])
}
