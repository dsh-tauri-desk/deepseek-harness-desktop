/**
 * client/service/summary.ts — 摘要 Query/Action（唯一与 store 的状态迁移出口）。
 */

import { getSummary } from '../apis'
import { store } from '../store'
import { sessionStateOf } from '../store/modules/session.utils'

/**
 * 拉取（或强制刷新）某会话摘要并写入 store。
 *
 * 不做在飞请求合并：`status === 'loading'` 本身就是合并判据，同一会话的多个 turn 卡片
 * 因此只会打同一份摘要，且 service 不持有模块级可变状态。
 */
export async function fetchSummary(input: { sessionId: string | undefined, force?: boolean }): Promise<void> {
  const { sessionId, force = false } = input
  if (sessionId === undefined)
    return
  const current = sessionStateOf(store.turnrewind.$state, sessionId)
  if (!force && (current.status === 'ready' || current.status === 'loading'))
    return
  store.turnrewind.patch(sessionId, { status: 'loading', error: null })
  try {
    const summary = await getSummary(sessionId)
    store.turnrewind.patch(sessionId, { status: 'ready', summary, error: null })
  }
  catch (error) {
    store.turnrewind.patch(sessionId, { status: 'error', error: messageOf(error) })
  }
}

/**
 * 登记「本轮卡片在等账本落定」，并在该会话尚未取过摘要时拉一次。
 *
 * after 快照在 turn/end 之后后台结算，卡片可能先于账本落地渲染；
 * 后续重试由 `register/summary.ts` 的调度器按账本是否已有该轮决定。
 */
export async function expectTurn(input: { sessionId: string | undefined, turn: number | undefined }): Promise<void> {
  const { sessionId, turn } = input
  if (sessionId === undefined)
    return
  const awaitingTurn = turn ?? null
  const current = sessionStateOf(store.turnrewind.$state, sessionId)
  if (current.awaitingTurn !== awaitingTurn)
    store.turnrewind.patch(sessionId, { awaitingTurn })
  // 已有摘要或正在取就不重复请求（并发挂载的多个卡片因此只打一份摘要）。
  if (current.status !== 'ready' && current.status !== 'loading')
    await fetchSummary({ sessionId })
}

// --- internal ---

/** 错误归一：`Error` 取 message，其余 `String()`（含响应体错误）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
