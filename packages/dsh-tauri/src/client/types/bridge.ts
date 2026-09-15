import type { ParentMessage } from './iframe'
import type { InvokeArgs } from './tauri'

export interface TauriEventBridgeMessage<T = unknown> extends ParentMessage {
  event: string
  /** Tauri 侧的事件 id；宿主未提供时为 0。 */
  id?: number
  payload: T
}

export interface InvokeBridgeRequest extends ParentMessage {
  type: 'dsh://tauri:invoke'
  cmd: string
  args?: InvokeArgs
  nonce: string
}

export interface InvokeBridgeReply extends ParentMessage {
  type: 'dsh://tauri:reply'
  nonce: string
  ok: boolean
  value?: unknown
  error?: string
}
