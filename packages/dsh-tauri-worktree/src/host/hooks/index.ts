/**
 * host/hooks.ts — 工作树插件生命周期钩子（hookable）。
 *
 * 会话事件轴：apply 的 ctx.on('session/event') 只是转发器，真正行为（工作树交接、
 * 检出上下文消费）挂为命名钩子 handler；第三方可 hook 同一事件扩展而不改插件本体。
 */

import { createHooks } from 'hookable'

/** 工作树插件对外可扩展的生命周期钩子。 */
export interface WorktreeLifecycleHooks {
  /** 会话 turn/end（工作树交接与检出上下文消费在此接线）。 */
  'session:turn-end': (session: any, event: any) => void
}

/** 创建插件生命周期钩子注册表（apply 装配时持有）。 */
export function createWorktreeHooks() {
  return createHooks<WorktreeLifecycleHooks>()
}
