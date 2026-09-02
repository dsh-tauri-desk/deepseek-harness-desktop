/**
 * register/prefill.ts — 「通过 Chat 创建」草稿预填桥的 slot 注册。
 *
 * 注册进 conversation.input.left 槽（照搬 dsh-automation index.ts 的
 * PrefillBridge 注册）；effect 生命周期内清理 inject 句柄。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { PrefillBridge } from '../components/prefill-bridge'
import {
  CONVERSATION_INPUT_LEFT_SLOT,
  INPUT_PREFILL_ID,
  INPUT_PREFILL_ORDER,
  INPUT_PREFILL_PRIORITY,
  PLUGIN_ID,
} from '../constants'

export function registerSchedulerPrefill(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposeSlot = ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT as never, () => ctx.slots.register({
      name: CONVERSATION_INPUT_LEFT_SLOT,
      id: INPUT_PREFILL_ID,
      registrant: PLUGIN_ID,
      order: INPUT_PREFILL_ORDER,
      priority: INPUT_PREFILL_PRIORITY,
      inject: (sessionId: string) => ({ sessionId }),
    } as never, PrefillBridge))
    return () => {
      disposeSlot()
    }
  }, `${PLUGIN_ID}: prefill`)
}
