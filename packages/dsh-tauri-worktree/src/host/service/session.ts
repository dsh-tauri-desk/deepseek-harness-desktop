/**
 * session.ts — 宿主会话定位：从 ctx 解析当前会话对象与项目根目录。
 *
 * findSession / resolveProjectPath 被路由（route.ts）与工具集（index.ts）共用，
 * 单独成域是为了避免 index ⇄ route 的循环依赖，并把「会话未知时不猜测」的竞态
 * 语义收敛到一处：
 *   - 会话没有任何路径信息时返回 null（调用方按「未知」处理）；
 *   - 绝不静默回退 process.cwd() 猜测：宿主进程的工作目录未必是 git 仓库，一旦
 *     误判 isGit: false，客户端会永久隐藏工作树模式选择器，直到刷新后才纠正。
 */

import type { HostContext } from '../types/index.js'
import { isAbsolute } from 'pathe'

/**
 * 从 ctx 拿到当前会话对象（优先用传入的 session，其次由 id 查 sessions）。
 * @param ctx 宿主根上下文
 * @param sessionId 会话 id（查不到时返回 undefined）
 */
export function findSession(ctx: HostContext, sessionId: string): any {
  if (!sessionId)
    return undefined
  try {
    return ctx.sessions.get(sessionId) ?? ctx.sessions.list().find((session: any) => session.id === sessionId)
  }
  catch {
    return undefined
  }
}

/**
 * 解析会话的项目根路径：优先 session.header.cwd / session.cwd，其次 workspaceRegistry
 * 按该路径解析工作区根。会话未知或没有任何路径信息时返回 null。
 *
 * 设计原因：新建会话/应用启动存在竞态——客户端列表已出现会话，但宿主 SessionStore
 * 尚无该会话或 header.cwd 尚未落定。返回 null 让客户端保持默认（git）并稍后重试。
 * @param ctx 宿主根上下文
 * @param session 会话对象
 * @returns 项目根路径；会话无路径信息时返回 null
 */
export async function resolveProjectPath(ctx: HostContext, session: any): Promise<string | null> {
  const cwd = typeof session?.header?.cwd === 'string'
    ? session.header.cwd
    : typeof session?.cwd === 'string'
      ? session.cwd
      : ''
  if (!cwd)
    return null
  if (isAbsolute(cwd))
    return cwd
  try {
    const ws = await ctx.workspaceRegistry.resolveByPath(cwd)
    if (ws?.path)
      return ws.path
  }
  catch {
    /* registry 不可用时忽略 */
  }
  return cwd
}
