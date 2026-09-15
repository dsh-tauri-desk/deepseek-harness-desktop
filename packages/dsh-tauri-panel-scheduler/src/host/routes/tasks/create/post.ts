import type { TaskInput } from '../../../types'
import { defineEventHandler, readBody } from 'dsh-tauri'
import { task } from '../../../service/task'

export default defineEventHandler(async (event) => {
  const body = await readBody<TaskInput>(event)
  if (body === undefined) {
    event.res.status = 400
    return { error: '请求体必须是对象' }
  }
  const result = await task.create(body)
  if (!result.ok) {
    event.res.status = 400
    return { error: result.error }
  }
  return { ok: true, task: result.task }
})
