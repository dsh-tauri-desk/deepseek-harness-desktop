/**
 * client/register/summary.ts — 摘要重试调度（副作用由 controller 托管）。
 *
 * after 快照在 turn/end 之后**后台结算**（大仓库可能十几秒才落账），因此卡片报告的这一轮
 * 可能暂时没有账本记录。判据是「账本还没有这一轮」而不是「卡片不可见」：该轮确实没有改动时
 * 账本会写一条空记录，那种情况不该继续重试。
 *
 * 定时器与重试记账都属于 controller 的可托管资源，组件里不再裸写 `setTimeout`。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import {
  TURNREWIND_SUMMARY_MAX_RETRIES,
  TURNREWIND_SUMMARY_RETRY_DELAY_MS,
  TURNREWIND_SUMMARY_RETRY_MAX_DELAY_MS,
  TURNREWIND_SUMMARY_TICK_MS,
} from '../constants'
import { fetchSummary } from '../service/summary'
import { store } from '../store'
import { hasTurnRecord, summaryRetryDelayMs } from '../utils/format'

export const summaryFeature = defineRegister<ClientContext>((controller) => {
  /** 每会话已重试次数与下次允许时刻（controller 闭包状态，卸载即丢弃）。 */
  const attempts = new Map<string, number>()
  const nextAt = new Map<string, number>()

  const forget = (sessionId: string): void => {
    attempts.delete(sessionId)
    nextAt.delete(sessionId)
  }

  controller.interval(() => {
    const now = Date.now()
    for (const [sessionId, state] of Object.entries(store.turnrewind.$state.bySession)) {
      const turn = state.awaitingTurn
      if (turn === null || state.status !== 'ready' || state.summary === null || !state.summary.isGit) {
        forget(sessionId)
        continue
      }
      if (hasTurnRecord(state.summary, turn)) {
        forget(sessionId)
        continue
      }
      const count = attempts.get(sessionId) ?? 0
      if (count >= TURNREWIND_SUMMARY_MAX_RETRIES || now < (nextAt.get(sessionId) ?? 0))
        continue
      attempts.set(sessionId, count + 1)
      nextAt.set(sessionId, now + summaryRetryDelayMs(count, TURNREWIND_SUMMARY_RETRY_DELAY_MS, TURNREWIND_SUMMARY_RETRY_MAX_DELAY_MS))
      void fetchSummary({ sessionId, force: true })
    }
  }, TURNREWIND_SUMMARY_TICK_MS)
})
