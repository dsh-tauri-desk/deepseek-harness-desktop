/**
 * host/service/undo.ts — 撤销一个 turn 的工作区改动。
 *
 * 顺序固定为「校验在飞 turn → 读账本 → 校验归属/代数 → 校验快照可用 → **冲突预检** →
 * 恢复 → 回写账本」：预检在动任何文件之前完成，命中冲突时不写一个字节。恢复过程不做
 * force 通道，部分失败如实上报且**不标记已撤销**，用户可以再点一次。
 *
 * 并发：整个 git 阶段跑在与捕获/结算/容量治理同一条工作区队列里——私有仓的 index 是
 * 共享可变状态，撤销与结算并发会撞 `index.lock` 或读到半更新的 index。
 */

import type { UndoConflict, UndoOutcome } from '../types'
import { defineService } from 'dsh-tauri'
import {
  REASON_ALREADY_UNDONE,
  REASON_CONFLICT,
  REASON_EXPIRED,
  REASON_GIT_REQUIRED,
  REASON_TURN_ACTIVE,
} from '../config/constants'
import { workspaceQueue } from '../config/runtime'
import { workspaceKey } from '../utils/workspace'
import { capture } from './capture'
import { ledger } from './ledger'
import { snapshot } from './snapshot'
import { turns } from './turns'
import { workspace } from './workspace'

export const undo = defineService({
  /**
   * 撤销指定 turn。
   * @returns 成功时给出已恢复/已删除/失败明细；失败时给出 HTTP 状态码与原因。
   */
  async turn(sessionId: string, turn: number): Promise<UndoOutcome> {
    // 该轮还在跑：after 快照未结算，撤销对象不成立（预览文件集也还没定）。
    if (capture.pending(sessionId, turn))
      return { ok: false, code: 409, error: REASON_TURN_ACTIVE }

    const current = await ledger.load(sessionId)
    const record = current.turns.find(item => item.turn === turn)
    if (record === undefined)
      return { ok: false, code: 404, error: '未找到该轮的文件变更记录' }
    if (!current.isGit || current.workspaceRoot === null)
      return { ok: false, code: 409, error: current.unavailableReason ?? REASON_GIT_REQUIRED }
    if (record.unavailable)
      return { ok: false, code: 409, error: record.unavailable }
    if (record.undoneAt !== null && record.undoneAt !== undefined)
      return { ok: false, code: 409, error: REASON_ALREADY_UNDONE }

    // 会话归属：cwd 可能后来被切到别的工作区，此时账本里的相对路径不再指向同一目录。
    const probe = await workspace.resolve(sessionId)
    if (probe.ok && workspaceKey(probe.root) !== workspaceKey(current.workspaceRoot))
      return { ok: false, code: 403, error: '会话当前工作区与该轮记录不一致，拒绝撤销' }

    const workspaceRoot = current.workspaceRoot
    const store = snapshot.resolve(workspaceRoot)

    // 快照仓代数：整仓被容量治理重建或被手工删除后，账本里引用旧代数的记录必然失效。
    // 这类记录直接落「过期」终态，避免用户每次点击都撞同一个不可用错误。
    const currentGeneration = await snapshot.generation(workspaceRoot)
    if (record.generation !== null && record.generation !== undefined
      && currentGeneration !== null && record.generation !== currentGeneration) {
      await turns.expired(sessionId, turn, REASON_EXPIRED)
      return { ok: false, code: 409, error: REASON_EXPIRED }
    }

    const outcome = await workspaceQueue.run(workspaceRoot, async (): Promise<UndoOutcome> => {
      const beforeCommit = await snapshot.read(store, record.beforeRef)
      const afterCommit = await snapshot.read(store, record.afterRef)
      if (beforeCommit === null || afterCommit === null) {
        // refs 不在了（仓库被清空/记录来自旧版本）：同样落过期终态。
        await turns.expired(sessionId, turn, REASON_EXPIRED)
        return { ok: false, code: 409, error: REASON_EXPIRED }
      }

      if (record.files.length === 0)
        return { ok: true, restored: [], removed: [], failed: [] }

      const conflicts = await snapshot.conflicts(store, afterCommit, record.files)
      if (!conflicts.ok)
        return { ok: false, code: 500, error: conflicts.reason }
      if (conflicts.conflicts.length > 0) {
        const details: UndoConflict[] = conflicts.conflicts
        return { ok: false, code: 409, error: REASON_CONFLICT, conflicts: details }
      }

      const report = await snapshot.restore(store, beforeCommit, record.files)
      return { ok: true, restored: report.restored, removed: report.removed, failed: report.failed }
    })

    if (outcome.ok && outcome.failed.length === 0)
      await turns.undone(sessionId, turn, Date.now())
    return outcome
  },
})
