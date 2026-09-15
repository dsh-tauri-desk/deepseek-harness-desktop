import { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'
import { capture } from '../service/capture'

/**
 * `turn/end`：提示条读数在 turn 边界**同步**作废（结算是后台的，大仓库要几秒到几十秒，
 * 不能让它决定提示条什么时候消失），after 快照与差异随后在后台结算。
 */
export function handleSessionEvent(session: any, event: any): void {
  if (event?.type !== 'turn/end')
    return
  const turn = event?.data?.turn
  if (typeof session?.id !== 'string' || typeof turn !== 'number')
    return
  capture.resetLive(session.id, turn)
  void capture.settle(session.id, turn).catch((error: unknown) => {
    console.warn(`${TURNREWIND_PLUGIN_NAME}: settle turn failed: ${String(error)}`)
  })
}
