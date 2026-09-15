import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { PET_PLUGIN_NAME } from '../../shared/constants'
import { PetPrefill } from '../components/prefill'
import {
  CONVERSATION_INPUT_LEFT_SLOT,
  PET_PREFILL_ID,
  PET_PREFILL_ORDER,
  PET_PREFILL_PRIORITY,
} from '../constants'

/** conversation.input.left 的一次性草稿注入（新建桌宠会话后把 /hatch 提示词填进输入框）。 */
export const prefillFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(CONVERSATION_INPUT_LEFT_SLOT as never, () => ctx.slots.register({
    name: CONVERSATION_INPUT_LEFT_SLOT,
    id: PET_PREFILL_ID,
    order: PET_PREFILL_ORDER,
    priority: PET_PREFILL_PRIORITY,
    registrant: PET_PLUGIN_NAME,
    inject: (sessionId: string) => ({ sessionId }),
  } as never, PetPrefill)))
})
