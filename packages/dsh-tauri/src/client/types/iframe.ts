/** 已校验的父窗口消息上下文。 */
export interface ParentMessageContext {
  /** 原始 message 事件（需要 `event.origin` 等原始信息时使用）。 */
  event: MessageEvent
}

export interface ParentMessage {
  type?: string
  [key: string]: unknown
}

export type ParentMessageTypes = string | readonly string[]
