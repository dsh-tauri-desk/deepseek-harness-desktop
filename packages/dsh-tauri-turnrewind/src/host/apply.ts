/**
 * host/apply.ts — turnrewind 插件装配（声明式接线，无业务逻辑）。
 *
 * 事件处理器的实现在 `events/`：宿主能力只经 `service/` 间接访问，装配层不传 deps 对象。
 */

import type { HostContext } from './types'
import { TURNREWIND_PLUGIN_NAME } from '../shared/constants'
import { clearHostRuntime, resetHostRuntime, setCurrentHostInstance } from './config/runtime'
import { handleAgentStatus } from './events/agent-status'
import { handlePreStep } from './events/pre-step'
import { handleSessionDisposed } from './events/session-disposed'
import { handleSessionEvent } from './events/session-event'
import { routes } from './routes'
import { capture } from './service/capture'

export function apply(ctx: HostContext): void {
  resetHostRuntime()
  setCurrentHostInstance(ctx)

  ctx.on('agent/pre-step', handlePreStep)
  ctx.on('session/event', handleSessionEvent)
  ctx.on('agent/status', handleAgentStatus)
  ctx.on('session/disposed', handleSessionDisposed)

  ctx.effect(() => routes(ctx), `${TURNREWIND_PLUGIN_NAME}: routes`)
  ctx.effect(() => () => capture.dispose(), `${TURNREWIND_PLUGIN_NAME}: turn capture`)
  ctx.effect(() => () => clearHostRuntime(), `${TURNREWIND_PLUGIN_NAME}: host runtime`)
}
