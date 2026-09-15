import { defineEventHandler, readBody } from 'dsh-tauri'
import { handoff } from '../../service/handoff'

interface CheckoutBody {
  sessionId?: unknown
  worktreeHashDirname?: unknown
  branchName?: unknown
  carryStaged?: unknown
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<CheckoutBody>(event)) ?? {}
  const result = await handoff.checkout(
    String(body.sessionId ?? ''),
    String(body.worktreeHashDirname ?? ''),
    String(body.branchName ?? ''),
    body.carryStaged === true,
  )
  if (!result.ok) {
    event.res.status = 400
    return { error: result.error }
  }
  return {
    ok: true,
    branch: result.branch,
    projectPath: result.projectPath,
    targetSessionId: result.targetSessionId,
  }
})
