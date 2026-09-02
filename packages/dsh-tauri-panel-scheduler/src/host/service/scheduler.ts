/**
 * host/service/scheduler.ts — 调度引擎：按计划轮询到期任务并触发执行。
 *
 * DSH 宿主没有内置 cron/定时服务（ctx.jobs 是作业注册表而非定时器），因此本插件
 * 自建一次性定时器节拍（apply 里 setInterval tick，宿主即 Node）。每个 tick：
 *   1. 加载任务，找出「到期」（nextRunAt 已过或缺失）且未在运行中的启用任务；
 *   2. 并发上限内逐个执行（executeTask 建独立会话 + followup）；
 *   3. 执行后按计划计算下次 nextRunAt 并回写持久化（客户端卡片展示下次运行时间）。
 */

import type { SchedulerLifecycleHooks } from '../hooks/index.js'
import type { HostContext, SchedulerTask } from '../types/index.js'
import { MAX_CONCURRENT_RUNS } from '../constants/index.js'
import { loadState, saveTasks } from '../storage/index.js'
import { executeTask } from './executor.js'
import { nextOccurrence } from './schedule.js'

/** 调度引擎：持有运行中任务集合，暴露 tick() 供 apply 的定时器驱动。 */
export class SchedulerEngine {
  private readonly running = new Set<string>()
  private readonly ctx: HostContext
  private readonly hooks: SchedulerLifecycleHooks

  constructor(ctx: HostContext, hooks: SchedulerLifecycleHooks) {
    this.ctx = ctx
    this.hooks = hooks
  }

  /** 任务是否正在执行（并发保护）。 */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  /** 手动触发单任务（立即执行）。返回是否已入队。 */
  async runNow(taskId: string): Promise<{ ok: boolean, error?: string }> {
    if (this.running.has(taskId))
      return { ok: false, error: '任务正在执行中' }
    const task = loadState().tasks.find(t => t.id === taskId)
    if (!task)
      return { ok: false, error: '任务不存在' }
    await this.fire(task, 'manual')
    return { ok: true }
  }

  /** 单个 tick：处理所有到期任务。 */
  async tick(): Promise<void> {
    const state = loadState()
    const tasks = state.tasks
    if (tasks.length === 0)
      return
    const now = Date.now()
    const due = tasks.filter(task =>
      task.enabled
      && !this.running.has(task.id)
      && (task.nextRunAt === undefined || new Date(task.nextRunAt).getTime() <= now),
    )
    // 未到期的任务无需任何处理；到期任务逐个执行（并发上限内）。
    let active = 0
    for (const task of due) {
      if (active >= MAX_CONCURRENT_RUNS)
        break
      active++
      void this.fire(task, 'schedule')
    }
    // 所有启用任务的下次触发时间若缺失则立即补齐（新任务/时间被未来时钟覆盖）。
    const changed = tasks.some(task => task.enabled && task.nextRunAt === undefined)
    if (changed) {
      for (const task of tasks) {
        if (task.enabled && task.nextRunAt === undefined) {
          const next = nextOccurrence(task.schedule, now)
          if (next !== undefined)
            task.nextRunAt = new Date(next).toISOString()
        }
      }
      await saveTasks(tasks)
    }
  }

  /** 触发一次执行（schedule 到期或 manual），执行完回填 nextRunAt。 */
  private async fire(task: SchedulerTask, trigger: 'schedule' | 'manual'): Promise<void> {
    if (this.running.has(task.id))
      return
    this.running.add(task.id)
    task.lastRunAt = new Date().toISOString()
    this.hooks.callHook?.('scheduler:task-start', { id: task.id, name: task.name }, trigger)
    try {
      await executeTask(this.ctx, task, trigger)
      this.hooks.callHook?.('scheduler:task-end', { id: task.id, name: task.name }, { ok: true })
    }
    catch (error) {
      this.hooks.callHook?.('scheduler:task-end', { id: task.id, name: task.name }, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    finally {
      this.running.delete(task.id)
      // 无论成败都推进到下次触发（失败也会按计划重试，避免卡死在同一次）。
      const now = Date.now()
      const next = nextOccurrence(task.schedule, now)
      task.nextRunAt = next === undefined ? undefined : new Date(next).toISOString()
      const state = loadState()
      const stored = state.tasks.find(t => t.id === task.id)
      if (stored) {
        stored.lastRunAt = task.lastRunAt
        stored.nextRunAt = task.nextRunAt
        await saveTasks(state.tasks)
      }
    }
  }
}
