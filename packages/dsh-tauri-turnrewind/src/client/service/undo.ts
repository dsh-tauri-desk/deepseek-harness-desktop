/**
 * client/service/undo.ts — 撤销某个 turn 的 Action（乐观更新与失败回滚同处一地）。
 */

import { postUndo } from '../apis'
import { store } from '../store'
import { fetchSummary } from './summary'

/**
 * 撤销某 turn 的文件改动。
 * 成功 → 强制刷新摘要（卡片转为「已撤销」）；409 → 展示冲突清单；其它 → 展示错误。
 */
export async function undoTurn(input: { sessionId: string | undefined, turn: number }): Promise<{ ok: boolean, error?: string }> {
  const { sessionId, turn } = input
  if (sessionId === undefined)
    return { ok: false, error: 'missing session' }
  store.turnrewind.patch(sessionId, { undoing: true, undoError: null, undoConflicts: [] })
  try {
    const { status, data } = await postUndo({ sessionId, turn })
    if (status >= 200 && status < 300 && data.ok !== false) {
      store.turnrewind.patch(sessionId, { undoing: false, undoError: null, undoConflicts: [] })
      await fetchSummary({ sessionId, force: true })
      return { ok: true }
    }
    const error = data.error ?? `HTTP ${status}`
    store.turnrewind.patch(sessionId, { undoing: false, undoError: error, undoConflicts: data.conflicts ?? [] })
    return { ok: false, error }
  }
  catch (error) {
    const text = messageOf(error)
    store.turnrewind.patch(sessionId, { undoing: false, undoError: text, undoConflicts: [] })
    return { ok: false, error: text }
  }
}

// --- internal ---

/** 错误归一：`Error` 取 message，其余 `String()`。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
