import type { RefObject } from 'react'
import { useEventListener } from '@reause/core'
import { getIframeOrigin } from '@/utils/iframe'

/** 已通过校验的消息上下文。 */
export interface IframeMessageContext {
  /** 已校验的 iframe origin，可直接用于 `postMessage` 回发 */
  origin: string
  /** 原始 message 事件 */
  event: MessageEvent
}

/**
 * 订阅 iframe → 宿主 的 `postMessage`（入站方向的唯一入口）。
 *
 * 只做两道与安全有关的校验：
 * 1. `event.source` 必须是**直接** iframe 的 `contentWindow`（不支持多层嵌套）；
 * 2. `event.origin` 与 iframe 的 http(s) origin 完全一致。
 *
 * 协议分发交给调用方按 `data.type` 处理——壳层所有入站桥共用同一个监听器与
 * 同一个 `switch (type)`，不再逐个桥比对 `data.source`。
 *
 * 回调经 reause `useEventListener` 的 ref 转发，写内联函数不会反复重订阅。
 */
export function useIframeMessage<T>(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  handler: (message: T, context: IframeMessageContext) => any,
): void {
  useEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data
    if (!data || typeof data !== 'object')
      return
    if (event.source !== iframeRef.current?.contentWindow)
      return

    const origin = getIframeOrigin(iframeRef)
    if (!origin || event.origin !== origin)
      return

    handler(data as T, { origin, event })
  })
}
