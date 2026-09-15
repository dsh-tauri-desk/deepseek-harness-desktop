import { defineEventHandler, readBody } from 'dsh-tauri'
import { handoff } from '../service/handoff'
import { sessionContext } from '../service/session-context'
import { worktree } from '../service/worktree'

interface CreateBody {
  sessionId?: unknown
  sourceSessionId?: unknown
  carryStaged?: unknown
  inherit?: unknown
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<CreateBody>(event)) ?? {}
  const sessionId = String(body.sessionId ?? '')
  const sourceSessionId = String(body.sourceSessionId ?? sessionId)
  if (!sessionId) {
    event.res.status = 400
    return { error: '缺少 sessionId' }
  }
  const projectPath = await sessionContext.resolve(sourceSessionId)
  if (!projectPath) {
    event.res.status = 400
    return { error: '无法解析会话工作目录：会话尚未就绪，请稍后重试' }
  }
  const created = await worktree.create(projectPath, sessionId, {
    sourceSessionId,
    carryStaged: body.carryStaged === true,
  })
  if (!created.ok) {
    event.res.status = 400
    return { error: created.error }
  }

  let inherited = false
  if (body.inherit === true) {
    const inheritedSession = await handoff.inherit(sourceSessionId, sessionId, created.binding.worktreePath)
    inherited = inheritedSession.ok
  }

  const { binding } = created
  return {
    ok: true,
    hash: binding.hash,
    dirname: binding.dirname,
    worktreeKey: `${binding.hash}/${binding.dirname}`,
    worktreePath: binding.worktreePath,
    projectPath: binding.projectPath,
    sourceSessionId: binding.sourceSessionId,
    log: created.log,
    existed: created.existed,
    inherited,
  }
})
