import { defineEventHandler, readBody } from 'dsh-tauri'
import { archive } from '../../../service/archive'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId?: unknown }>(event, { type: 'json' })
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId.length === 0) {
    event.res.status = 400
    return { ok: false as const, error: 'invalid-session-id' }
  }
  return archive.delete(sessionId)
})
