import { defineEventHandler, getQuery } from 'dsh-tauri'
import { castArray } from 'lodash-es'
import { runs } from '../../service/runs'

export default defineEventHandler(async (event) => {
  const raw = getQuery<Record<string, string | string[] | undefined>>(event).taskId
  const taskId = castArray(raw)[0] ?? ''
  return { runs: await runs.list(taskId === '' ? undefined : taskId) }
})
