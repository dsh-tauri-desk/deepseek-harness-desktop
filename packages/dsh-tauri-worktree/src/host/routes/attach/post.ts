import { defineEventHandler, readBody } from 'dsh-tauri'
import { workspace } from '../../service/workspace'

interface AttachBody {
  sessionId?: unknown
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<AttachBody>(event)) ?? {}
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  const result = await workspace.attach(sessionId)
  if (!result.ok) {
    event.res.status = 404
    return { error: result.error }
  }
  return { ok: true, workspaceId: result.workspaceId }
})
