/**
 * lib/worktree.ts — 工作树客户端的纯函数（无 DOM、无 React、无副作用）。
 * 从 features/mode-select.tsx 与 session.ts 剥离，便于单测与复用。
 */

import type { SessionsRuntime, WorkspaceSessionOrder } from '../types'

/**
 * 等待新工作树会话的输入服务就绪（新建会话发布与 Session scope 可寻址
 * 并非同一时刻；直接调 setDraft/submit 会因服务未就绪而静默失败）。
 */
export async function waitForInputActions(sessionsRuntime: SessionsRuntime, sessionId: string): Promise<import('../types').InputActions> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const actions = sessionsRuntime.provideInfo(sessionId)?.props?.inputActions
    if (actions)
      return actions
    await new Promise<void>(resolve => window.setTimeout(resolve, 100))
  }
  throw new Error('新工作树会话的输入服务尚未就绪')
}

/** 返回目标工作区与当前首个其他会话，供检出会话插到工作区最上方。 */
export function resolveWorkspaceTopInsertion(
  workspaces: readonly WorkspaceSessionOrder[],
  projectPath: string,
  targetSessionId: string,
): { workspaceId: string, beforeSessionId?: string } | undefined {
  const workspace = workspaces.find(item => item.path === projectPath)
  if (!workspace)
    return undefined
  return {
    workspaceId: workspace.workspaceId,
    beforeSessionId: workspace.sessionIds.find(id => id !== targetSessionId),
  }
}
