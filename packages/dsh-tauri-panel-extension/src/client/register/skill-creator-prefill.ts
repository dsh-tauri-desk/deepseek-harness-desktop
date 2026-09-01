/**
 * register/skill-creator-prefill.ts — 技能创建器草稿预填的 slot 注册。
 *
 * 注册进 conversation.input.left 槽；effect 生命周期内清理登记集合与 inject 句柄。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { SkillCreatorPrefill } from '../components/skill-creator-prefill'
import { pendingPrefills } from '../config'
import {
  CONVERSATION_INPUT_LEFT_SLOT,
  INPUT_PREFILL_ID,
  INPUT_PREFILL_ORDER,
  INPUT_PREFILL_PRIORITY,
  PLUGIN_ID,
} from '../constants'

export function registerSkillCreatorPrefill(ctx: ClientContext): void {
  ctx.effect(() => {
    pendingPrefills.clear()
    const disposeSlot = ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT as never, () => ctx.slots.register({
      name: CONVERSATION_INPUT_LEFT_SLOT,
      id: INPUT_PREFILL_ID,
      registrant: PLUGIN_ID,
      order: INPUT_PREFILL_ORDER,
      priority: INPUT_PREFILL_PRIORITY,
      inject: (sessionId: string) => ({ sessionId }),
    } as never, SkillCreatorPrefill))
    return () => {
      pendingPrefills.clear()
      disposeSlot()
    }
  }, `${PLUGIN_ID}: skill creator prefill`)
}
