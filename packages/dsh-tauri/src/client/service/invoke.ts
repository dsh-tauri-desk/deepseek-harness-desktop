import type { InvokeBridgeReply, InvokeBridgeRequest } from '../types/bridge'
import type { InvokeArgs, InvokeOptions } from '../types/tauri'
import { invokeParent } from './invoke-parent'
import { getNonce } from './invoke.utils'
import { listenParent } from './listen-parent'

/** invoke 请求消息类型。 */
export const TYPE_INVOKE = 'dsh://tauri:invoke'
/** invoke 应答消息类型。 */
export const TYPE_INVOKE_REPLY = 'dsh://tauri:reply'
/** 单次 invoke 等待宿主应答的最长毫秒数（超时按失败处理）。 */
export const INVOKE_TIMEOUT_MS = 15000

export function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  _options?: InvokeOptions,
): Promise<T> {
  const nonce = getNonce()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unlisten = listenParent<InvokeBridgeReply>((reply) => {
      if (reply.type !== TYPE_INVOKE_REPLY || reply.nonce !== nonce)
        return
      settle(reply)
    })
    function settle(reply: InvokeBridgeReply): void {
      if (settled)
        return
      settled = true
      if (timer !== undefined)
        clearTimeout(timer)
      unlisten()
      if (reply.ok) {
        resolve(reply.value as T)
      }
      else {
        reject(new Error(reply.error || `NODE_NOT_ANSWERED: invoke ${cmd} rejected by host`))
      }
    }

    // 超时保护：宿主未应答（监听器未挂载/iframe 非 dsh 环境等）时按失败处理
    timer = setTimeout(() => {
      if (settled)
        return
      unlisten()
      settled = true
      reject(new Error(`NODE_NOT_ANSWERED: invoke ${cmd} timed out`))
    }, INVOKE_TIMEOUT_MS)

    const request: InvokeBridgeRequest = {
      type: TYPE_INVOKE,
      cmd,
      args,
      nonce,
    }
    // 未送达（无宿主 / payload 不可克隆）时立即失败，不等超时
    const sent = invokeParent(request)
    if (!sent.ok) {
      if (timer !== undefined)
        clearTimeout(timer)
      if (settled)
        return
      settled = true
      unlisten()
      reject(sent.error ?? new Error(`NODE_NOT_ANSWERED: invoke ${cmd} not delivered`))
    }
  })
}
