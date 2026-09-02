/**
 * host/hooks/index.ts — 调度器生命周期钩子（hookable）。
 *
 * 插件对外可扩展的生命周期钩子：任务执行前/后、状态变化。第三方可 hook 同一事件
 * 扩展而不改插件本体（与 dsh-tauri-worktree 的 hooks 一致的模式）。
 */

import { createHooks } from 'hookable'

/** 调度器生命周期钩子定义。 */
export interface SchedulerLifecycleHooks {
  /** 任务执行开始前（携带任务定义与触发来源）。 */
  'scheduler:task-start': (task: { id: string, name: string }, trigger: 'schedule' | 'manual') => void
  /** 任务执行结束（携带任务 id 与结果）。 */
  'scheduler:task-end': (task: { id: string, name: string }, outcome: { ok: boolean, error?: string }) => void
  /** 任务被创建/更新/删除/启停（携带任务 id 与操作类型）。 */
  'scheduler:task-change': (taskId: string, action: 'create' | 'update' | 'toggle' | 'delete') => void
}

/** 创建调度器生命周期钩子注册表（apply 装配时持有）。 */
export function createSchedulerHooks() {
  return createHooks<SchedulerLifecycleHooks>()
}
