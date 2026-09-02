/**
 * host/service/manager.ts — 定时任务的 CRUD / 启停 / 删除（路由与 Agent 工具共用）。
 *
 * 变更操作统一在此收敛：校验入参、计算 nextRunAt、原子持久化，返回结构化结果，
 * 供 HTTP 路由与 agent 工具复用，避免两处逻辑漂移。
 */

import type { SchedulerRun, SchedulerSchedule, SchedulerTask } from '../types/index.js'
import { randomUUID } from 'node:crypto'
import { NAME_MAX_LENGTH, PROMPT_MAX_LENGTH } from '../constants/index.js'
import { loadState, saveRuns, saveTasks } from '../storage/index.js'
import { localTimeZone, nextOccurrence, validateSchedule } from './schedule.js'

/** 任务创建入参。 */
export interface TaskInput {
  name: string
  schedule: SchedulerSchedule
  prompt: string
  workspaceId?: string
  mode?: string
  module?: string
  enabled?: boolean
}

/** 从输入创建任务对象（含 id/时间戳/nextRunAt）。 */
export function buildTask(input: TaskInput): SchedulerTask {
  const now = new Date()
  const schedule = input.schedule
  // 时间戳缺省用宿主本地时区；interval 无时间字段。
  const timeZone = typeof schedule.timeZone === 'string' && schedule.timeZone
    ? schedule.timeZone
    : localTimeZone()
  const normalized: SchedulerSchedule = { ...schedule, timeZone } as SchedulerSchedule
  const next = nextOccurrence(normalized, now.getTime())
  return {
    id: `task-${randomUUID()}`,
    name: input.name.trim(),
    schedule: normalized,
    prompt: input.prompt,
    workspaceId: input.workspaceId || undefined,
    mode: input.mode || undefined,
    module: input.module || undefined,
    enabled: input.enabled ?? true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: next === undefined ? undefined : new Date(next).toISOString(),
  }
}

/** 校验创建/更新入参，返回错误信息或 null。 */
export function validateTaskInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null)
    return '请求体必须是对象'
  const value = input as Partial<TaskInput>
  if (typeof value.name !== 'string' || value.name.trim() === '')
    return '任务名称不能为空'
  if (value.name.trim().length > NAME_MAX_LENGTH)
    return `任务名称不能超过 ${NAME_MAX_LENGTH} 个字符`
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '')
    return '任务指令不能为空'
  if (value.prompt.length > PROMPT_MAX_LENGTH)
    return `任务指令不能超过 ${PROMPT_MAX_LENGTH} 个字符`
  if (!validateSchedule(value.schedule))
    return '计划配置无效'
  return null
}

/** 新增任务。返回 [ok, task|error]。 */
export async function createTask(input: TaskInput): Promise<{ ok: true, task: SchedulerTask } | { ok: false, error: string }> {
  const invalid = validateTaskInput(input)
  if (invalid !== null)
    return { ok: false, error: invalid }
  const state = loadState()
  const task = buildTask(input)
  state.tasks.push(task)
  await saveTasks(state.tasks)
  return { ok: true, task }
}

/** 更新任务（合并语义；undefined 字段保持不变）。 */
export async function updateTask(
  id: string,
  patch: Partial<TaskInput>,
): Promise<{ ok: true, task: SchedulerTask } | { ok: false, error: string }> {
  const state = loadState()
  const task = state.tasks.find(t => t.id === id)
  if (!task)
    return { ok: false, error: '任务不存在' }
  const merged: TaskInput = {
    name: patch.name ?? task.name,
    schedule: patch.schedule ?? task.schedule,
    prompt: patch.prompt ?? task.prompt,
    workspaceId: patch.workspaceId === undefined ? task.workspaceId : patch.workspaceId,
    mode: patch.mode === undefined ? task.mode : patch.mode,
    module: patch.module === undefined ? task.module : patch.module,
    enabled: patch.enabled ?? task.enabled,
  }
  const invalid = validateTaskInput(merged)
  if (invalid !== null)
    return { ok: false, error: invalid }
  const built = buildTask(merged)
  task.name = built.name
  task.schedule = built.schedule
  task.prompt = built.prompt
  task.workspaceId = built.workspaceId
  task.mode = built.mode
  task.module = built.module
  task.enabled = built.enabled
  task.updatedAt = new Date().toISOString()
  task.nextRunAt = built.nextRunAt
  await saveTasks(state.tasks)
  return { ok: true, task }
}

/** 启用/暂停。返回 [ok, task|error]。 */
export async function setTaskEnabled(id: string, enabled: boolean): Promise<{ ok: true, task: SchedulerTask } | { ok: false, error: string }> {
  const state = loadState()
  const task = state.tasks.find(t => t.id === id)
  if (!task)
    return { ok: false, error: '任务不存在' }
  task.enabled = enabled
  task.updatedAt = new Date().toISOString()
  if (enabled && task.nextRunAt === undefined) {
    const next = nextOccurrence(task.schedule, Date.now())
    if (next !== undefined)
      task.nextRunAt = new Date(next).toISOString()
  }
  await saveTasks(state.tasks)
  return { ok: true, task }
}

/** 删除任务（保留执行历史，任务名快照已存在）。 */
export async function deleteTask(id: string): Promise<{ ok: true } | { ok: false, error: string }> {
  const state = loadState()
  const index = state.tasks.findIndex(t => t.id === id)
  if (index === -1)
    return { ok: false, error: '任务不存在' }
  state.tasks.splice(index, 1)
  await saveTasks(state.tasks)
  return { ok: true }
}

/** 读取执行历史（按开始时间倒序；可选按任务过滤）。 */
export function listRuns(taskId?: string): SchedulerRun[] {
  const state = loadState()
  const runs = taskId ? state.runs.filter(r => r.taskId === taskId) : state.runs
  return [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** 读取任务列表（保持持久化顺序）。 */
export function listTasks(): SchedulerTask[] {
  return loadState().tasks
}

/** 启动自愈：把上次进程中断留下的 running 记录标记为 failed（host_interrupted）。 */
export async function recoverInterruptedRuns(): Promise<void> {
  const state = loadState()
  let changed = false
  for (const run of state.runs) {
    if (run.status === 'running') {
      run.status = 'failed'
      run.finishedAt = new Date().toISOString()
      run.error = run.error || 'host_interrupted'
      changed = true
    }
  }
  if (changed)
    await saveRuns(state.runs)
}
