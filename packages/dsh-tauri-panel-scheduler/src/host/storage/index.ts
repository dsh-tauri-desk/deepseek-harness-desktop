/**
 * host/storage/index.ts — 调度器任务/执行记录持久化。
 *
 * 用 dsh-tauri 的 createAtomicFsStorage（tmp+rename 原子写）把 tasks/runs 存为
 * 两个小 JSON 文件，位于 `$DSH_HOME/dsh-tauri-panel-scheduler/`，手写可恢复。
 * 同步读面（loadState）保留给路由与调度引擎启动路径。
 */

import type { SchedulerRun, SchedulerState, SchedulerTask } from '../types/index.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { createAtomicFsStorage } from 'dsh-tauri'
import { join } from 'pathe'
import { RUNS_HISTORY_LIMIT, RUNS_KEY, SCHEDULER_STATE_DIRECTORY, TASKS_KEY } from '../constants/index.js'
import { validateSchedule } from '../service/schedule.js'

/** 插件状态目录（默认 `$DSH_HOME/dsh-tauri-panel-scheduler`）。 */
export function schedulerStateDir(dshHome: string | undefined = process.env.DSH_HOME): string {
  return join(dshHome ?? join(homedir(), '.dsh'), SCHEDULER_STATE_DIRECTORY)
}

function stateStore(dshHome?: string) {
  return createAtomicFsStorage(schedulerStateDir(dshHome))
}

function isTask(value: unknown): value is SchedulerTask {
  return typeof value === 'object' && value !== null
    && typeof (value as SchedulerTask).id === 'string'
    && typeof (value as SchedulerTask).name === 'string'
    && typeof (value as SchedulerTask).prompt === 'string'
    && typeof (value as SchedulerTask).enabled === 'boolean'
    && validateSchedule((value as SchedulerTask).schedule)
}

function isRun(value: unknown): value is SchedulerRun {
  return typeof value === 'object' && value !== null
    && typeof (value as SchedulerRun).id === 'string'
    && typeof (value as SchedulerRun).taskId === 'string'
    && typeof (value as SchedulerRun).taskName === 'string'
    && typeof (value as SchedulerRun).status === 'string'
    && typeof (value as SchedulerRun).startedAt === 'string'
    && typeof (value as SchedulerRun).scheduledFor === 'string'
}

/** 同步读取状态文档；tasks/runs 各自独立容错，损坏或缺失互不影响。 */
export function loadState(dshHome?: string): SchedulerState {
  const dir = schedulerStateDir(dshHome)
  const tasks = (() => {
    try {
      const raw = JSON.parse(readFileSync(join(dir, TASKS_KEY), 'utf8')) as { tasks?: unknown[] } | null
      return Array.isArray(raw?.tasks) ? raw.tasks.filter(isTask) : []
    }
    catch {
      return []
    }
  })()
  const runs = (() => {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, RUNS_KEY), 'utf8')) as { runs?: unknown[] } | null
      return Array.isArray(parsed?.runs) ? parsed.runs.filter(isRun) : []
    }
    catch {
      return []
    }
  })()
  return { version: 1, tasks, runs }
}

/** 原子持久化整个状态文档。 */
export async function saveState(state: SchedulerState, dshHome?: string): Promise<void> {
  const store = stateStore(dshHome)
  await store.setItem(TASKS_KEY, `${JSON.stringify({ version: 1, tasks: state.tasks }, null, 2)}\n`)
  // runs 单独落盘，避免每次任务变更都重写大历史。
  await store.setItem(RUNS_KEY, `${JSON.stringify({ version: 1, runs: state.runs }, null, 2)}\n`)
}

/** 只持久化任务列表（runs 不动）。 */
export async function saveTasks(tasks: SchedulerTask[], dshHome?: string): Promise<void> {
  await stateStore(dshHome).setItem(TASKS_KEY, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`)
}

/** 只持久化执行记录（超限裁剪）。 */
export async function saveRuns(runs: SchedulerRun[], dshHome?: string): Promise<void> {
  const trimmed = runs.slice(-RUNS_HISTORY_LIMIT)
  await stateStore(dshHome).setItem(RUNS_KEY, `${JSON.stringify({ version: 1, runs: trimmed }, null, 2)}\n`)
}

/** 状态目录是否已存在（供启动迁移/自愈判定）。 */
export function stateDirExists(dshHome?: string): boolean {
  return existsSync(schedulerStateDir(dshHome))
}

// ---------------------------------------------------------------------------
// 单写者队列：串行化 load-modify-save 临界区
// ---------------------------------------------------------------------------
// tasks/runs 是整表读写（loadState → 变更 → saveTasks/saveRuns）。同一时刻并发
// 的变更（多个到点任务同时收敛、HTTP 与工具并发 CRUD）若交错 load-modify-save，
// 后写覆盖先写 → 丢更新。createAtomicFsStorage 只保证单次写入原子，不保证
// 读改写互斥，因此这里用一条 promise 链把所有「读整表→改→写整表」串起来，
// 天然单写者。读（loadState/listTasks/listRuns）不加锁（快照读，容忍短暂旧值）。

let stateLock: Promise<unknown> = Promise.resolve()

/** 在单写者队列中执行一次读改写临界区（fn 返回 Promise 或同步值）。 */
export function withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = stateLock.then(() => fn())
  // 失败不阻断后续排队项（异常由调用方按各自语义处理）。
  stateLock = run.then(() => undefined, () => undefined)
  return run
}
