import type { RefObject } from 'react'
import { getIframeOrigin } from '@/utils/iframe'

/** 宿主 → iframe 消息的协议标识（与 `src-tauri/src/desktop/nav.rs` 的 `data.source !== 'dsh-desktop'` 校验一致）。 */
export const IFRAME_HOST_SOURCE = 'dsh-desktop'

/** 宿主 → iframe 的消息体：`type` 必填（如 `dsh://sidebar:toggle`），其余字段按具体协议附带。 */
export interface IframeOutboundMessage {
  type: string
  [key: string]: unknown
}

/**
 * 向 iframe 发消息（宿主 → iframe 方向的唯一出口）。
 *
 * - 每次发送都按 iframe 当前的 http(s) origin 定向投递；iframe 未挂载 / 来源非法
 *   （`about:blank`、`file:` 等）时丢弃本次发送，不排队；
 * - 自动补协议标识 `source: 'dsh-desktop'`（`desktop/nav.rs` 按它识别宿主；通知类
 *   注入脚本只看 `type`，多一个字段无副作用）；调用方自带 `source` 时以它为准。
 *
 * @example
 * const post = useIframePost(iframeRef)
 * post({ type: 'dsh://sidebar:toggle' })
 */
export function useIframePost(
  iframeRef: RefObject<HTMLIFrameElement | null>,
): (message: IframeOutboundMessage) => void {
  return function post(message: IframeOutboundMessage) {
    const origin = getIframeOrigin(iframeRef)
    if (!origin)
      return
    iframeRef.current?.contentWindow?.postMessage({ source: IFRAME_HOST_SOURCE, ...message }, origin)
  }
}
