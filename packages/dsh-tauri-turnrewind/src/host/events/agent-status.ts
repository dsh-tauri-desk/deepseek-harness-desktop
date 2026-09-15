import { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'
import { capture } from '../service/capture'

/**
 * 兜底：被取消/中断而没走到 `turn/end` 的 turn，在会话空闲时结算。
 * 同样立刻作废读数，提示条不跨轮残留。
 */
export function handleAgentStatus(payload: any): void {
  if (payload?.status !== 'idle')
    return
  const sessionId = payload?.agent?.session?.id
  if (typeof sessionId !== 'string')
    return
  capture.resetLive(sessionId)
  void capture.settleIdle(sessionId).catch((error: unknown) => {
    console.warn(`${TURNREWIND_PLUGIN_NAME}: idle settle failed: ${String(error)}`)
  })
}
