import type { DiscardJob, OperationResult } from '../types'
import { randomUUID } from 'node:crypto'
import { defineService } from 'dsh-tauri'
import { filter, find, findLast, get, take } from 'lodash-es'
import { DISCARD_JOB_RETENTION, DISCARD_RETRY_ATTEMPTS, DISCARD_RETRY_DELAY_MS } from '../config/constants'

const jobs = new Map<string, DiscardJob>()
const inFlight = new Map<string, Promise<DiscardJob>>()

const jobsArray = (): DiscardJob[] => [...jobs.values()]

export const cleaner = defineService({
  start(
    sessionId: string,
    worktreeKey: string,
    worktreePath: string | undefined,
    run: () => Promise<OperationResult>,
  ): DiscardJob {
    const reused = reuseOf(sessionId, worktreeKey)
    if (reused)
      return reused

    const job: DiscardJob = {
      jobId: randomUUID(),
      sessionId,
      worktreeKey,
      worktreePath,
      state: 'deleting',
    }
    prune()
    jobs.set(job.jobId, job)
    void execute(job, keyOf(sessionId, worktreeKey), run)
    return job
  },

  lookup(sessionId: string, jobId?: string): DiscardJob | undefined {
    return jobId ? jobs.get(jobId) : findLast(jobsArray(), { sessionId })
  },

  unsettled(): DiscardJob[] {
    return filter(jobsArray(), job => job.state !== 'completed')
  },
})

// --- internal ---

function keyOf(sessionId: string, worktreeKey: string): string {
  return `${sessionId}:${worktreeKey}`
}

function findJob(sessionId: string, worktreeKey: string, state: DiscardJob['state']): DiscardJob | undefined {
  return find(jobsArray(), { sessionId, worktreeKey, state })
}

function reuseOf(sessionId: string, worktreeKey: string): DiscardJob | undefined {
  if (inFlight.has(keyOf(sessionId, worktreeKey)))
    return findJob(sessionId, worktreeKey, 'deleting')
  return findJob(sessionId, worktreeKey, 'completed')
}

function prune(): void {
  if (jobs.size < DISCARD_JOB_RETENTION)
    return
  const removable = filter(jobsArray(), { state: 'completed' })
  take(removable, jobs.size - DISCARD_JOB_RETENTION + 1)
    .forEach(job => jobs.delete(job.jobId))
}

function execute(job: DiscardJob, key: string, run: () => Promise<OperationResult>): Promise<DiscardJob> {
  const existing = inFlight.get(key)
  if (existing)
    return existing

  const settle = (state: DiscardJob['state'], error?: string): DiscardJob => {
    const updated: DiscardJob = { ...job, state, ...(error === undefined ? {} : { error }) }
    jobs.set(job.jobId, updated)
    return updated
  }

  const promise = (async (): Promise<DiscardJob> => {
    let lastError = ''
    for (let attempt = 0; attempt < DISCARD_RETRY_ATTEMPTS; attempt += 1) {
      const result = await run()
      if (result.ok)
        return settle('completed')
      lastError = result.error
      if (attempt + 1 < DISCARD_RETRY_ATTEMPTS)
        await new Promise(resolve => setTimeout(resolve, DISCARD_RETRY_DELAY_MS))
    }
    return settle('failed', lastError)
  })()
    .catch((error: unknown): DiscardJob => settle('failed', get(error, 'message', String(error))))
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}
