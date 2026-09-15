import { defineEventHandler, getQuery } from 'dsh-tauri'
import { castArray } from 'lodash-es'
import { tasks } from '../../service/tasks'

export default defineEventHandler(async (event) => {
  const raw = getQuery<Record<string, string | string[] | undefined>>(event).search
  const search = castArray(raw)[0] ?? ''
  return { tasks: await tasks.list(search) }
})
