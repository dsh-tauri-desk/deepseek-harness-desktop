/**
 * host/service/turns.ts — 每会话账本的变更编排（load-modify-save 串行 + 保留窗口治理）。
 *
 * 同一会话的 load-modify-save 全部经过 {@link mutate} 串行化，避免「捕获结算」与
 * 「撤销回写」交叉覆盖；队尾结算即出队，长期运行不会每会话常驻一条 Promise。
 */

import type { SessionLedger, TurnRecord } from '../types'
import type { LedgerMutation, WorkspaceState } from './turns.types'
import { defineService } from 'dsh-tauri'
import { ledgerQueues } from '../config/runtime'
import { ledger } from './ledger'
import { applyRetention, markExpired, markUndone, putRecord } from './turns.utils'

export const turns = defineService({
  /** 追加/覆盖某 turn 的记录；返回需要调用方删除的 refs（保留窗口淘汰时非空）。 */
  async record(sessionId: string, record: TurnRecord): Promise<string[]> {
    const mutation = await mutate(sessionId, current => putRecord(current, record))
    return mutation.refsToDelete
  },

  /** 记录工作区资格结论（非 Git / 被拒绝的目录也要留痕）。 */
  async note(sessionId: string, state: WorkspaceState): Promise<void> {
    await mutate(sessionId, (current) => {
      if (current.workspaceRoot === state.workspaceRoot
        && current.isGit === state.isGit
        && current.unavailableReason === state.unavailableReason) {
        return null
      }
      return { ...current, ...state }
    })
  },

  /** 标记某 turn 已撤销；返回是否命中记录。 */
  async undone(sessionId: string, turn: number, at: number): Promise<boolean> {
    let hit = false
    await mutate(sessionId, (current) => {
      const next = markUndone(current, turn, at)
      if (next !== null)
        hit = true
      return next
    })
    return hit
  },

  /**
   * 把某 turn 标记为过期（refs 已消失 / 快照仓代数不匹配），使卡片能给出确定结论，
   * 而不是每次点击都重复撞同一个「快照不可用」错误。
   */
  async expired(sessionId: string, turn: number, reason: string, at = Date.now()): Promise<boolean> {
    let hit = false
    await mutate(sessionId, (current) => {
      const next = markExpired(current, turn, reason, at)
      if (next !== null)
        hit = true
      return next
    })
    return hit
  },
})

// --- internal ---

/** 在会话级串行区内执行 load-modify-save，并顺带做保留窗口治理。 */
async function mutate(sessionId: string, task: (current: SessionLedger) => SessionLedger | null): Promise<LedgerMutation> {
  const previous = ledgerQueues.get(sessionId) ?? Promise.resolve()
  const run = previous.then(async (): Promise<LedgerMutation> => {
    const current = await ledger.load(sessionId)
    const next = task(current)
    if (next === null)
      return { refsToDelete: [] }
    const retained = applyRetention(next, Date.now())
    await ledger.save(retained.ledger)
    return { refsToDelete: retained.refsToDelete }
  })
  // 队尾只保留「已结算」的守卫，并在结算后出队：否则每见过一个会话就常驻一条 Promise。
  const guard = run.then(() => undefined, () => undefined)
  ledgerQueues.set(sessionId, guard)
  void guard.then(() => {
    if (ledgerQueues.get(sessionId) === guard)
      ledgerQueues.delete(sessionId)
  })
  return run
}
