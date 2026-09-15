import type { OperationResult, SchedulerSchedule, SchedulerTask, TaskInput } from '../types'
import { randomUUID } from 'node:crypto'
import { defineService } from 'dsh-tauri'
import { defaults, isEmpty, isNil, isObject, omitBy, pick } from 'lodash-es'
import { SCHEDULER_NAME_MAX_LENGTH, SCHEDULER_PROMPT_MAX_LENGTH } from '../config/constants'
import { localTimeZone, nextOccurrence, validateSchedule } from '../utils/schedule'
import { tasks } from './tasks'

export const task = defineService({
  async create(input: TaskInput): Promise<OperationResult<{ task: SchedulerTask }>> {
    const invalid = validateInput(input)
    if (invalid !== null)
      return { ok: false, error: invalid }
    const created = build(input)
    await tasks.save(created)
    return { ok: true, task: created }
  },

  async update(id: string, patch: Partial<TaskInput>): Promise<OperationResult<{ task: SchedulerTask }>> {
    const current = await tasks.load(id)
    if (current === null)
      return { ok: false, error: '任务不存在' }
    const merged = merge(current, patch)
    const invalid = validateInput(merged)
    if (invalid !== null)
      return { ok: false, error: invalid }
    const updated = { ...build(merged), id: current.id }
    await tasks.save(updated)
    return { ok: true, task: updated }
  },

  async toggle(id: string, enabled: boolean): Promise<OperationResult<{ task: SchedulerTask }>> {
    const current = await tasks.load(id)
    if (current === null)
      return { ok: false, error: '任务不存在' }
    const next: SchedulerTask = { ...current, enabled, updatedAt: new Date().toISOString() }
    if (enabled && isNil(next.nextRunAt)) {
      const occurrence = nextOccurrence(next.schedule, Date.now())
      if (occurrence !== undefined)
        next.nextRunAt = new Date(occurrence).toISOString()
    }
    await tasks.save(next)
    return { ok: true, task: next }
  },

  async remove(id: string): Promise<OperationResult> {
    return await tasks.remove(id) ? { ok: true } : { ok: false, error: '任务不存在' }
  },

  async advance(id: string, lastRunAt: string | undefined, nextRunAt: string | undefined): Promise<void> {
    const current = await tasks.load(id)
    if (current === null)
      return
    await tasks.save({
      ...current,
      lastRunAt,
      nextRunAt,
      updatedAt: new Date().toISOString(),
    })
  },
})

// --- internal ---

const OPTIONAL_FIELDS = ['recommendationId', 'workspaceId', 'permission', 'provider', 'model', 'reasoningEffort'] as const

function build(input: TaskInput): SchedulerTask {
  const now = new Date()
  const schedule = input.schedule
  const anchored = (schedule.kind === 'interval' || schedule.kind === 'custom') && isEmpty(schedule.anchor)
    ? { ...schedule, anchor: now.toISOString() }
    : schedule
  const timeZone = isEmpty(anchored.timeZone) ? localTimeZone() : anchored.timeZone
  const normalized = { ...anchored, timeZone } as SchedulerSchedule
  const next = nextOccurrence(normalized, now.getTime())
  return {
    id: `task-${randomUUID()}`,
    name: input.name.trim(),
    schedule: normalized,
    prompt: input.prompt,
    ...omitBy(pick(input, ...OPTIONAL_FIELDS), isEmpty),
    enabled: input.enabled ?? true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: next === undefined ? undefined : new Date(next).toISOString(),
  }
}

function merge(current: SchedulerTask, patch: Partial<TaskInput>): TaskInput {
  return defaults({}, patch, current)
}

function validateInput(input: unknown): string | null {
  if (!isObject(input))
    return '请求体必须是对象'
  const value = input as Partial<TaskInput>
  if (typeof value.name !== 'string' || value.name.trim() === '')
    return '任务名称不能为空'
  if (value.name.trim().length > SCHEDULER_NAME_MAX_LENGTH)
    return `任务名称不能超过 ${SCHEDULER_NAME_MAX_LENGTH} 个字符`
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '')
    return '任务指令不能为空'
  if (value.prompt.length > SCHEDULER_PROMPT_MAX_LENGTH)
    return `任务指令不能超过 ${SCHEDULER_PROMPT_MAX_LENGTH} 个字符`
  if (!validateSchedule(value.schedule))
    return '计划配置无效'
  return null
}
