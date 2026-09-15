import { defineService } from 'dsh-tauri'
import { get, isString } from 'lodash-es'
import { isAbsolute } from 'pathe'
import { getCurrentHostInstance } from '../config/runtime'

export const sessionContext = defineService({
  peek(sessionId: string): any {
    if (!sessionId)
      return null
    try {
      const ctx: any = getCurrentHostInstance()
      return ctx.sessions.get(sessionId)
        ?? ctx.sessions.list().find((session: any) => session.id === sessionId)
        ?? null
    }
    catch {
      return null
    }
  },

  async resolve(sessionId: string): Promise<string | null> {
    const session = sessionContext.peek(sessionId)
    const cwd = get(session, 'header.cwd') ?? get(session, 'cwd')
    if (!isString(cwd) || !cwd)
      return null
    if (!cwd)
      return null
    if (isAbsolute(cwd))
      return cwd
    try {
      const workspace = await getCurrentHostInstance().workspaceRegistry.resolveByPath(cwd)
      return workspace?.path || cwd
    }
    catch {
      return cwd
    }
  },
})
