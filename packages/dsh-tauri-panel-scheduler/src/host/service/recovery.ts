import { defineService } from 'dsh-tauri'
import { filter } from 'lodash-es'
import { SCHEDULER_INTERRUPTED_ERROR } from '../config/constants'
import { runs } from './runs'

export const recovery = defineService({
  async recover(): Promise<void> {
    for (const run of filter(await runs.list(), { status: 'running' })) {
      await runs.save({
        ...run,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
        error: run.error || SCHEDULER_INTERRUPTED_ERROR,
      })
    }
  },
})
