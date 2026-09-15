import { defineEventHandler, readBody } from 'dsh-tauri'
import { archive } from '../../../../service/archive'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionIds?: unknown }>(event, { type: 'json' })
  const sessionIds = Array.isArray(body?.sessionIds)
    ? body.sessionIds.map(String).filter(Boolean)
    : []
  if (sessionIds.length === 0) {
    event.res.status = 400
    return { ok: false as const, error: 'invalid-session-ids' }
  }
  return archive.archiveWorkspace(sessionIds)
})
