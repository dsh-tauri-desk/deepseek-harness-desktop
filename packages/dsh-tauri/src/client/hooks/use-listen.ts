import type { EventCallback, Options, UnlistenFn } from '../types'
import { useEffect, useRef } from 'react'
import { listen } from '../service/listen'

/**
 * 订阅一个「宿主转发进 iframe 的 Tauri 事件」，卸载时自动注销。
 *
 * - 语义对齐 `service/listen`（签名同 `@tauri-apps/api/event` 的 `listen`），
 *   回调与 options 经 ref 转发（latest ref），调用方写内联函数不会反复重订阅，
 *   只在 `event` 变化时重新订阅；
 * - 竞态防护：`listen` 返回 Promise，若在 resolve 前组件已卸载则立即注销，
 *   避免监听泄漏；
 * - 唯一的 effect 只负责注册/注销（需要清理），无其它副作用。
 *
 * @example
 * useListen<PetStatus>('pet://status', event => setStatus(event.payload))
 */
export function useListen<T>(event: string, handler: EventCallback<T>, options?: Options): void {
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)
  handlerRef.current = handler
  optionsRef.current = options

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let disposed = false

    void listen<T>(event, tauriEvent => handlerRef.current(tauriEvent), optionsRef.current)
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
