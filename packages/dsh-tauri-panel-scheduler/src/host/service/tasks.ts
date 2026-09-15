import type { SchedulerTask } from '../types'
import { defineService } from 'dsh-tauri'
import { conformsTo, filter, find, findIndex, isArray, isBoolean, isString, reject } from 'lodash-es'
import { SCHEDULER_TASKS_KEY } from '../config/constants'
import { withWriteQueue } from '../config/runtime'
import { storage } from '../storage'
import { validateSchedule } from '../utils/schedule'

export const tasks = defineService({
  async list(search?: string): Promise<SchedulerTask[]> {
    const raw = await storage.getItem<{ tasks?: unknown[] }>(SCHEDULER_TASKS_KEY)
    const all = filter(isArray(raw?.tasks) ? raw.tasks : [], isTask)
    const needle = search?.trim().toLowerCase() ?? ''
    return needle === '' ? all : filter(all, item => item.name.toLowerCase().includes(needle))
  },

  async load(id: string): Promise<SchedulerTask | null> {
    return find(await tasks.list(), { id }) ?? null
  },

  async save(task: SchedulerTask): Promise<void> {
    await withWriteQueue(async () => {
      const all = await tasks.list()
      const at = findIndex(all, { id: task.id })
      if (at === -1)
        all.push(task)
      else
        all[at] = task
      await writeTasks(all)
    })
  },

  async remove(id: string): Promise<boolean> {
    return withWriteQueue(async () => {
      const all = await tasks.list()
      const remaining = reject(all, { id })
      if (remaining.length === all.length)
        return false
      await writeTasks(remaining)
      return true
    })
  },
})

// --- internal ---

function isTask(value: unknown): value is SchedulerTask {
  return conformsTo(value, {
    id: isString,
    name: isString,
    prompt: isString,
    enabled: isBoolean,
    schedule: validateSchedule,
  })
}

async function writeTasks(all: SchedulerTask[]): Promise<void> {
  await storage.setItem(SCHEDULER_TASKS_KEY, `${JSON.stringify({ version: 1, tasks: all }, null, 2)}\n`)
}
