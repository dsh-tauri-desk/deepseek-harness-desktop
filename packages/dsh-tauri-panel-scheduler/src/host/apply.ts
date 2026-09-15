import type { HostContext } from './types'
import {
  SCHEDULER_RECOVER_EFFECT,
  SCHEDULER_ROUTES_EFFECT,
  SCHEDULER_RUNTIME_EFFECT,
  SCHEDULER_TICK_EFFECT,
  SCHEDULER_TICK_MS,
} from './config/constants'
import { clearHostRuntime, setCurrentHostInstance } from './config/runtime'
import { routes } from './routes'
import { recovery } from './service/recovery'
import { scheduler } from './service/scheduler'
import { createTaskTool } from './tools/create-task'
import { deleteTaskTool } from './tools/delete-task'
import { listTasksTool } from './tools/list-tasks'
import { runTaskTool } from './tools/run-task'
import { toggleTaskTool } from './tools/toggle-task'

export interface Config {
  tickMs?: number
}

export function apply(ctx: HostContext, config: Config = {}): void {
  setCurrentHostInstance(ctx)

  ctx.tools.register(createTaskTool())
  ctx.tools.register(listTasksTool())
  ctx.tools.register(toggleTaskTool())
  ctx.tools.register(deleteTaskTool())
  ctx.tools.register(runTaskTool())

  const tickMs = Number.isFinite(config?.tickMs) && (config.tickMs as number) > 0
    ? (config.tickMs as number)
    : SCHEDULER_TICK_MS

  ctx.effect(() => {
    void recovery.recover().catch((error: unknown) => {
      ctx.logger?.warn?.('dsh-tauri-panel-scheduler: recover interrupted runs failed', error)
    })
  }, SCHEDULER_RECOVER_EFFECT)

  ctx.effect(() => scheduler.start(tickMs), SCHEDULER_TICK_EFFECT)
  ctx.effect(() => routes(ctx), SCHEDULER_ROUTES_EFFECT)
  ctx.effect(() => () => clearHostRuntime(), SCHEDULER_RUNTIME_EFFECT)
}
