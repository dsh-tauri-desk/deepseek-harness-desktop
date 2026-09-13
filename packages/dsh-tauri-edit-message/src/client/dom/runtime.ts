/**
 * client/dom/runtime.ts — apply() 装入的宿主服务句柄。
 *
 * DOM 注入模块不在 apply() 的闭包里，用这个模块级句柄承接 sessions 服务；
 * 句柄只由 apply() 写入一次。
 */

import type { SessionsService } from '../types'

let sessionsService: SessionsService | null = null

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
  const list = sessionsService?.list
  if (!list || typeof list.getSnapshot !== 'function')
    return undefined
  const snapshot = list.getSnapshot()
  return typeof snapshot.current === 'string' ? snapshot.current : undefined
}

/** 会话出现在 list 快照后再导航（应用不认未列出的 id）。 */
export function openWhenListed(sessionId: string): void {
  const sessions = sessionsService
  if (!sessions)
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
