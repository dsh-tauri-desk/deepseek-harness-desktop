import { defineEventHandler, readBody } from 'dsh-tauri'
import { task } from '../../../service/task'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ id?: unknown }>(event)
  const id = typeof body?.id === 'string' ? body.id : ''
  if (id.length === 0) {
    event.res.status = 400
    return { error: '缺少任务 id' }
  }
  const result = await task.remove(id)
  if (!result.ok) {
    event.res.status = 400
    return { error: result.error }
  }
  return { ok: true }
})
