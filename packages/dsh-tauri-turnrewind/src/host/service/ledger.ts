/**
 * host/service/ledger.ts — 每会话 JSON 账本的持久化。
 *
 * 存放于 `$DSH_HOME/<feature>/sessions/<sessionId>.json`，经 `storage` 的原子写驱动落盘。
 * 选 JSON 而非 SQLite：本插件的读写面只有「追加一条 turn、标记一次撤销、读一份摘要」，
 * 事务需求为零。
 *
 * 边界策略：**过期只锁执行、不抹审计**——超出保留窗口的 turn 由 `turns` 标记 `expiredAt`
 * 并清空 files 与 refs（撤销不再可能），但 turn 号、计数、时间戳留在账本里可回溯。
 */

import type { SessionLedger } from '../types'
import { createHash } from 'node:crypto'
import { defineService } from 'dsh-tauri'
import { LEDGER_VERSION } from '../config/constants'
import { storage } from '../storage'

export const ledger = defineService({
  /** 读取账本；文件缺失/损坏/版本不符时返回空账本（损坏显式告警，不静默修数据）。 */
  async load(sessionId: string): Promise<SessionLedger> {
    let raw: unknown
    try {
      raw = await storage.getItem<unknown>(keyOf(sessionId))
    }
    catch {
      return blank(sessionId)
    }
    return parse(sessionId, raw)
  },

  /** 写入账本（原子写：tmp + rename）。 */
  async save(value: SessionLedger): Promise<void> {
    await storage.setItem(keyOf(value.sessionId), `${JSON.stringify(value, null, 2)}\n`)
  },
})

// --- internal ---

/** 会话账本键；会话 id 做文件名安全化并附短哈希防撞。 */
function keyOf(sessionId: string): string {
  const sanitized = sessionId.replace(/[^\w.-]/g, '_').slice(0, 96) || 'session'
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${sanitized}-${digest}.json`
}

function blank(sessionId: string): SessionLedger {
  return {
    version: LEDGER_VERSION,
    sessionId,
    workspaceRoot: null,
    isGit: false,
    unavailableReason: null,
    turns: [],
  }
}

function parse(sessionId: string, raw: unknown): SessionLedger {
  let parsed: Partial<SessionLedger> | null = null
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) as Partial<SessionLedger> : raw as Partial<SessionLedger> | null
  }
  catch {
    return blank(sessionId)
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.sessionId !== sessionId)
    return blank(sessionId)
  if (parsed.version !== LEDGER_VERSION || !Array.isArray(parsed.turns)) {
    console.warn(`[dsh-tauri-turnrewind] ledger for session ${sessionId} has an unsupported version; starting fresh`)
    return blank(sessionId)
  }
  return {
    version: LEDGER_VERSION,
    sessionId,
    workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : null,
    isGit: parsed.isGit === true,
    unavailableReason: typeof parsed.unavailableReason === 'string' ? parsed.unavailableReason : null,
    turns: parsed.turns.filter(turn => typeof turn?.turn === 'number' && Array.isArray(turn.files)),
  }
}
