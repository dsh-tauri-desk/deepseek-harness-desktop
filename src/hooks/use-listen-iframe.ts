import type { Event as TauriEvent } from '@tauri-apps/api/event'
import type { RefObject } from 'react'
import { useIframePost } from '@/hooks/use-iframe-post'
import { useListen } from '@/hooks/use-listen'

/** 转发进 iframe 的消息体：`type` 必填，其余字段按具体协议附带。 */
export interface IframeForwardMessage {
  type: string
  [key: string]: unknown
}

/**
 * 监听一个 Tauri 事件，并把载荷按「宿主 → iframe」协议转发进 iframe。
 *
 * 与 `useInvokeIframe` 是**相反方向**的一对：
 * - `useInvokeIframe`：iframe → 宿主（postMessage 请求 → 执行 Tauri `invoke` → 回传结果）；
 * - `useListenIframe`：宿主 → iframe（本 hook，Tauri 事件 → postMessage 推送）。
 *
 * 行为约定：
 * - `useListen` 负责订阅与卸载注销（回调经 ref 转发，写内联函数不会反复重订阅）；
 * - 发送经 `useIframePost`（origin 定向 + `source: 'dsh-desktop'` 协议标识）；
 *   iframe 未挂载 / 来源非法时丢弃本次转发（事件是瞬时通知，过期即无意义）；
 * - `forward` 返回 `type` 为空的消息则不发送。
 *
 * 目前尚无调用方（壳层现有的宿主 → iframe 推送仍写在 `layout/components/iframe.tsx`
 * 里），先按协议定义好，新增「Tauri 事件 → iframe」通道时直接复用。
 *
 * @example
 * ```tsx
 * // 系统通知被点击 → 让 iframe 聚焦对应会话
 * useListenIframe<{ sessionId?: string | null }>(
 *   iframeRef,
 *   'dsh-notification-clicked',
 *   payload => ({ type: 'dsh://focus-session', sessionId: payload.sessionId ?? undefined }),
 * )
 * ```
 */
export function useListenIframe<T>(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  event: string,
  forward: (payload: T, event: TauriEvent<T>) => IframeForwardMessage,
): void {
  const post = useIframePost(iframeRef)

  useListen<T>(event, (tauriEvent) => {
    const message = forward(tauriEvent.payload, tauriEvent)
    if (!message || typeof message.type !== 'string' || message.type === '')
      return
    post(message)
  })
}
