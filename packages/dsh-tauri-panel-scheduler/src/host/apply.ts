/**
 * host/apply.ts — 调度器插件装配。
 *
 * 装配顺序与 reasons：
 *   1. 注册 Agent 工具（通过 Chat 创建/管理定时任务）；
 *   2. 启动自愈（把上次进程中断的 running 记录标记为 failed）；
 *   3. 注册 HTTP 路由（/api/dsh-scheduler/*，客户端 UI 经此调用）；
 *   4. 启动调度引擎 tick（宿主即 Node，setInterval 节拍驱动到期任务）。
 *   卸载时统一释放定时器与路由。
 */

import type { HostContext } from './types/index.js'
import { SCHEDULER_TICK_MS } from './constants/index.js'
import { createSchedulerHooks } from './hooks/index.js'
import { buildRoutes } from './routes/index.js'
import { recoverInterruptedRuns } from './service/manager.js'
import { SchedulerEngine } from './service/scheduler.js'
import { createToolSet } from './tools/index.js'

export type { SchedulerLifecycleHooks } from './hooks/index.js'

/** 可选配置。 */
export interface Config {
  /** 调度 tick 间隔（毫秒）；默认 SCHEDULER_TICK_MS。 */
  tickMs?: number
}

/**
 * 插件体：注册工具、HTTP 路由与调度引擎。
 * @param ctx - 宿主根上下文（注入 tools/webServer/agents/workspaceRegistry/connection）。
 * @param config - 插件行配置。
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  const tickMs = Number.isFinite(config?.tickMs) && (config.tickMs as number) > 0
    ? (config.tickMs as number)
    : SCHEDULER_TICK_MS

  const hooks = createSchedulerHooks()
  const engine = new SchedulerEngine(ctx, hooks)

  // 1) Agent 工具注册。
  for (const tool of createToolSet(engine))
    ctx.tools.register(tool)

  // 2) 启动自愈：上次进程中断留下的 running 记录标记为 failed。
  ctx.effect(() => {
    void recoverInterruptedRuns().catch((error: unknown) => {
      ctx.logger?.warn?.('dsh-tauri-panel-scheduler: recover interrupted runs failed', error)
    })
  }, 'dsh-tauri-panel-scheduler: recover interrupted runs')

  // 3) HTTP 路由注册（卸载统一释放）。
  ctx.effect(() => {
    const disposers = buildRoutes(ctx, engine).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-tauri-panel-scheduler: http routes')

  // 4) 调度引擎 tick。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void engine.tick().catch((error: unknown) => {
        ctx.logger?.warn?.('dsh-tauri-panel-scheduler: tick failed', error)
      })
    }, tickMs)
    return () => clearInterval(timer)
  }, 'dsh-tauri-panel-scheduler: tick')
}
