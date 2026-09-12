import type { ParentMessage, ParentMessageTypes } from '../types'
import { useEffect, useRef } from 'react'
import { listenParent } from '../service/listen-parent'

/** 「监听主窗口消息」的过滤条件：省略表示监听全部消息。 */
export type UseListenParentTypes = ParentMessageTypes | undefined

/**
 * React 版的 `listenParent`：组件挂载时监听主窗口（宿主）消息，卸载时自动取消。
 *
 * - 回调经 ref 转发（latest ref），调用方写内联函数不会导致反复重订阅；
 * - `types` 只在「归一化后的 key」变化时重订阅（数组字面量每次渲染都是新引用，
 *   直接用引用做依赖会每帧重订阅）；
 * - 与 `service/listen.ts` 的 Tauri 语义不同：这里收的是**桥原始消息**（按 `type`
 *   过滤自己那一档），适合插件自有协议；要订阅宿主转发的 Tauri 事件用 `listen`。
 */
export function useListenParent<T extends ParentMessage>(
  types: UseListenParentTypes,
  handler: (message: T) => void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const typesKey = types === undefined ? '' : (typeof types === 'string' ? types : types.join('\u0000'))

  useEffect(
    () => listenParent<T>(message => handlerRef.current(message), types),
    // types 的引用不稳定，用归一化 key 作为依赖（语义等价：同一组 type 不重订阅）
    // eslint-disable-next-line react/exhaustive-deps
    [typesKey],
  )
}
