import type { SessionLedger, TurnRecord } from '../types'
import { MAX_TURN_RECORDS, MAX_TURNS_PER_SESSION, REASON_EXPIRED } from '../config/constants'

/** 追加/覆盖某 turn 的记录（同号覆盖，保持按 turn 升序）。 */
export function putRecord(ledger: SessionLedger, record: TurnRecord): SessionLedger {
  const turns = ledger.turns.filter(item => item.turn !== record.turn)
  turns.push(record)
  turns.sort((left, right) => left.turn - right.turn)
  return { ...ledger, turns }
}

/** 标记某 turn 已撤销；未命中返回 null（调用方据此跳过落盘）。 */
export function markUndone(ledger: SessionLedger, turn: number, at: number): SessionLedger | null {
  if (!ledger.turns.some(item => item.turn === turn))
    return null
  return {
    ...ledger,
    turns: ledger.turns.map(item => (item.turn === turn ? { ...item, undoneAt: at } : item)),
  }
}

/** 标记某 turn 过期（refs 已消失 / 快照仓代数不匹配）；已过期或未命中返回 null。 */
export function markExpired(ledger: SessionLedger, turn: number, reason: string, at: number): SessionLedger | null {
  const target = ledger.turns.find(item => item.turn === turn)
  if (target === undefined || (target.expiredAt !== null && target.expiredAt !== undefined))
    return null
  return {
    ...ledger,
    turns: ledger.turns.map(item => (item.turn === turn
      ? { ...item, expiredAt: at, unavailable: reason, files: [], beforeRef: '', afterRef: '' }
      : item)),
  }
}

/**
 * 对账本做「保留窗口 + 硬上限」治理（纯函数）。
 *
 * 过期行只保留审计信息：清空文件明细与 refs，避免账本与载荷随历史无限增长；
 * 只有超过硬上限的最老行才会被真正丢弃。
 */
export function applyRetention(ledger: SessionLedger, now: number): { ledger: SessionLedger, refsToDelete: string[] } {
  const turns = [...ledger.turns].sort((left, right) => left.turn - right.turn)
  const refsToDelete: string[] = []
  const reversible = turns.filter(turn => turn.expiredAt === null || turn.expiredAt === undefined)
  const excess = new Set(
    reversible.slice(0, Math.max(0, reversible.length - MAX_TURNS_PER_SESSION)).map(turn => turn.turn),
  )
  const marked = turns.map((turn) => {
    if (!excess.has(turn.turn))
      return turn
    if (turn.beforeRef.length > 0)
      refsToDelete.push(turn.beforeRef)
    if (turn.afterRef.length > 0)
      refsToDelete.push(turn.afterRef)
    return {
      ...turn,
      expiredAt: now,
      unavailable: REASON_EXPIRED,
      files: [],
      beforeRef: '',
      afterRef: '',
    }
  })
  const dropCount = Math.max(0, marked.length - MAX_TURN_RECORDS)
  for (const turn of marked.slice(0, dropCount)) {
    if (turn.beforeRef.length > 0)
      refsToDelete.push(turn.beforeRef)
    if (turn.afterRef.length > 0)
      refsToDelete.push(turn.afterRef)
  }
  return {
    ledger: { ...ledger, turns: dropCount > 0 ? marked.slice(dropCount) : marked },
    refsToDelete,
  }
}
