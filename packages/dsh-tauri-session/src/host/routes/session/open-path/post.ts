import { defineEventHandler, readBody } from 'dsh-tauri'
import { sessionFiles } from '../../../service/session-files'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId?: unknown }>(event, { type: 'json' })
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId.length === 0) {
    event.res.status = 400
    return { ok: false as const, error: 'invalid-session-id' }
  }

  const result = await sessionFiles.open(sessionId)
  if (!result.ok)
    event.res.status = 400
  return result
})
