import type { SchedulerRun } from '../types'
import { defineService } from 'dsh-tauri'
import { conformsTo, filter, find, findIndex, isArray, isString, orderBy, reject, takeRight } from 'lodash-es'
import { SCHEDULER_RUNS_HISTORY_LIMIT, SCHEDULER_RUNS_KEY } from '../config/constants'
import { withWriteQueue } from '../config/runtime'
import { storage } from '../storage'

export const runs = defineService({
  async list(taskId?: string): Promise<SchedulerRun[]> {
    const raw = await storage.getItem<{ runs?: unknown[] }>(SCHEDULER_RUNS_KEY)
    const all = filter(isArray(raw?.runs) ? raw.runs : [], isRun)
    return orderBy(taskId ? filter(all, { taskId }) : all, 'startedAt', 'desc')
  },

  async load(id: string): Promise<SchedulerRun | null> {
    return find(await runs.list(), { id }) ?? null
  },

  async save(run: SchedulerRun): Promise<void> {
    await withWriteQueue(async () => {
      const all = await runs.list()
      const at = findIndex(all, { id: run.id })
      if (at === -1)
        all.push(run)
      else
        all[at] = run
      await writeRuns(takeRight(all, SCHEDULER_RUNS_HISTORY_LIMIT))
    })
  },

  async remove(id: string): Promise<boolean> {
    return withWriteQueue(async () => {
      const all = await runs.list()
      const remaining = reject(all, { id })
      if (remaining.length === all.length)
        return false
      await writeRuns(remaining)
      return true
    })
  },
})

// --- internal ---

function isRun(value: unknown): value is SchedulerRun {
  return conformsTo(value, {
    id: isString,
    taskId: isString,
    taskName: isString,
    status: isString,
    startedAt: isString,
    scheduledFor: isString,
  })
}

async function writeRuns(all: SchedulerRun[]): Promise<void> {
  await storage.setItem(SCHEDULER_RUNS_KEY, `${JSON.stringify({ version: 1, runs: all }, null, 2)}\n`)
}
