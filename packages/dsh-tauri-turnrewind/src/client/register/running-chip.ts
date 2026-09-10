/**
 * register/running-chip.ts — 把「运行中」提示条注册进 `conversation.input.dock`。
 *
 * 该槽是 **list** 型、**可叠加**（0.1.2-rc.1 与 0.1.5-rc.1 均为 list/session、
 * owner 为 InputZone），因此不需要像 turnTail 那样抢占选举，与工作树状态条
 * 等其他 dock 条目并存；order -30 让提示条排在官方任务清单（0）与工作树横幅
 * （-10）**之上**（原因见 constants 里 {@link TURNREWIND_RUNNING_CHIP_ORDER} 的注释）。
 *
 * sessionId 走 inject 工厂首参（两内核的框架解析结果），owner 份额里的会话快照
 * 只作为「是否还在运行」的可选提示。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { RunningChangesChip } from '../components/running-changes-chip'
import {
  TURNREWIND_INPUT_DOCK_SLOT,
  TURNREWIND_PLUGIN_NAME,
  TURNREWIND_RUNNING_CHIP_ID,
  TURNREWIND_RUNNING_CHIP_ORDER,
} from '../constants'

/**
 * 注册运行中提示条。
 * @param ctx - 客户端根上下文（须已注入 slots）。
 * @returns 释放 inject 句柄的 disposer。
 */
export function registerRunningChangesChip(ctx: ClientContext): () => void {
  return ctx.slots.inject(
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
  )
}
