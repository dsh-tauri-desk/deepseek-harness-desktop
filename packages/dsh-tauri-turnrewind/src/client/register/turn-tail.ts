/**
 * client/register/turn-tail.ts — 把变更卡片注册进 `conversation.chat.turnTail`。
 *
 * 该槽是 **chain** 型：升序 priority 依次征询 select，首个返回非 null 的条目当选，同一轮只渲染
 * 一个条目。官方 `ui-deliverables` 以默认 priority 0 注册，本插件用更低的 priority 抢先当选，
 * 用带撤销能力的卡片替换官方 “Files changed” 行。
 *
 * select 必须是**纯函数**（只读 owner props）：因此「本轮有没有记录」不能在那里判断，只能先
 * 无脑当选，再由组件按 store 状态决定渲染内容。能力探测放在 inject 工厂里（渲染那一刻），
 * 该服务由另一个客户端插件发布，apply 顺序不保证它已经就位。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import { TurnChangesCard } from '../components/turn-changes-card'
import {
  TURNREWIND_PLUGIN_NAME,
  TURNREWIND_TURN_TAIL_PRIORITY,
  TURNREWIND_TURN_TAIL_SLOT,
} from '../constants'
import { readCapabilities } from '../service/capabilities'

/** chain 征询用的 owner props 视图（框架派发 turnTail 的 owner 份额）。 */
interface TurnTailOwnerLike {
  turn?: { turn?: number } | undefined
}

export const turnTailFeature = defineRegister<ClientContext>((controller, ctx) => {
  controller.add(ctx.slots.inject(
    TURNREWIND_TURN_TAIL_SLOT as never,
    () =>
      ctx.slots.register(
        {
          name: TURNREWIND_TURN_TAIL_SLOT,
          registrant: TURNREWIND_PLUGIN_NAME,
          priority: TURNREWIND_TURN_TAIL_PRIORITY,
          select: (owner: TurnTailOwnerLike) => ({ turn: owner?.turn?.turn ?? 0 }),
          inject: (sessionId?: string) => ({ sessionId, capabilities: readCapabilities(ctx) }),
        } as never,
        TurnChangesCard as never,
      ),
  ))
})
