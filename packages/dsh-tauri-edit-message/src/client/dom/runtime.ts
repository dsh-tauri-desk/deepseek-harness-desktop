/**
 * client/dom/runtime.ts — apply() 装入的宿主服务句柄。
 *
 * DOM 注入模块不在 apply() 的闭包里，用这个模块级句柄承接 sessions 服务；
 * 句柄只由 apply() 写入一次。
 */

import type { SessionsService } from '../types'

let sessionsService: SessionsService | null = null

/** 宽松视图：ISessions 的类型面未必声明 list / open / fork，运行时才有。 */
function store(): SessionsService | undefined {
  return sessionsService ?? undefined
}

/** 记录 apply() 解析到的 sessions 服务。 */
export function setSessionsService(service: SessionsService | null): void {
  sessionsService = service
}

/** 会话导航服务；apply() 之前为 null。 */
export function getSessions(): SessionsService | null {
  return sessionsService
}

/** 当前会话 id：行上没有该属性，取会话列表快照的 current。 */
export function currentSessionId(): string | undefined {
  const list = store()?.list
  if (!list || typeof list.getSnapshot !== 'function')
    return undefined
  const snapshot = list.getSnapshot()
  return typeof snapshot.current === 'string' ? snapshot.current : undefined
}

/**
 * 该会话所属的侧栏工作区 id（扫描工作区列表的 sessionIds）。
 *
 * 与 DSH-EasyRewrite `resetConversation` 的「场景1工作区定位」同一判据：首轮编辑要
 * 在同一工作区里开一个空白新会话，否则新会话会掉进「未分组」。
 */
export function workspaceOf(session: SessionsService, sessionId: string): string | undefined {
  const workspaces = (session as { workspaces?: unknown }).workspaces as {
    list?: { getSnapshot?: () => { items?: Array<{ workspaceId?: string, sessionIds?: readonly string[] }> } }
  } | undefined
  const snapshot = workspaces?.list?.getSnapshot?.()
  const items = snapshot?.items
  if (!Array.isArray(items))
    return undefined
  for (const item of items) {
    if (item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
      return item.workspaceId
  }
  return undefined
}

/**
 * 在同一工作区建一个全新会话（首轮 reset：没有可锚的闭合回合，不能 fork）。
 *
 * `session/create` 的 workspaceId 与 cwd 互斥，且只有 workspaceId 会 attachSession；
 * 定位不到工作区时退回不传参数（由宿主按默认工作区处理）。
 */
export async function createFreshSession(session: SessionsService, workspaceId: string | undefined): Promise<string> {
  const create = session.create
  if (typeof create !== 'function')
    throw new Error('当前内核没有提供会话创建能力（sessions.create），无法重置对话。')
  const created = workspaceId === undefined ? await create() : await create({ workspaceId })
  if (typeof created !== 'string' || created === '')
    throw new Error('会话创建没有返回新的会话 id。')
  return created
}

/** 会话出现在 list 快照后再导航（应用不认未列出的 id）。 */
export function openWhenListed(sessionId: string): void {
  const sessions = store()
  if (!sessions || typeof sessions.open !== 'function')
    return
  const list = sessions.list
  if (!list || typeof list.getSnapshot !== 'function') {
    sessions.open(sessionId)
    return
  }
  if (list.getSnapshot().byId[sessionId] !== undefined) {
    sessions.open(sessionId)
    return
  }
  const stop = list.subscribe(() => {
    if (list.getSnapshot().byId[sessionId] !== undefined) {
      stop()
      sessions.open(sessionId)
    }
  })
}
