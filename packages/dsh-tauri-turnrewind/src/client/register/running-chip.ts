/**
 * client/register/running-chip.ts — 把「运行中」提示条注册进 `conversation.input.dock`。
 *
 * 该槽是 **list** 型、**可叠加**，因此不需要像 turnTail 那样抢占选举，与工作树状态条等其他
 * dock 条目并存；负 order 让提示条排在官方任务清单与工作树横幅之上（理由见 constants）。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { RunningChangesChip } from '../components/running-changes-chip'
import {
  TURNREWIND_INPUT_DOCK_SLOT,
  TURNREWIND_PLUGIN_NAME,
  TURNREWIND_RUNNING_CHIP_ID,
  TURNREWIND_RUNNING_CHIP_ORDER,
} from '../constants'

export const runningChipFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(
    TURNREWIND_INPUT_DOCK_SLOT as never,
    () =>
      ctx.slots.register(
        {
          name: TURNREWIND_INPUT_DOCK_SLOT,
          id: TURNREWIND_RUNNING_CHIP_ID,
          order: TURNREWIND_RUNNING_CHIP_ORDER,
          registrant: TURNREWIND_PLUGIN_NAME,
          inject: (sessionId?: string) => ({ sessionId }),
        } as never,
        RunningChangesChip as never,
      ),
  ))
})
