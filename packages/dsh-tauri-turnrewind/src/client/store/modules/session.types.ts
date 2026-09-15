import type { SessionSummary } from '../../types'

/** 每会话客户端状态（只放数据；请求与重试记账在 service/ 与 register/）。 */
export interface TurnrewindSessionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  summary: SessionSummary | null
  error: string | null
  /**
   * 卡片报告的本轮 turn 号；账本尚无该轮记录时由 register 的调度器重拉。
   * null 表示这一轮的卡片没有在等账本（例如非 Git 工作区）。
   */
  awaitingTurn: number | null
  /** 撤销进行中。 */
  undoing: boolean
  /** 撤销失败提示（含冲突清单）。 */
  undoError: string | null
  undoConflicts: Array<{ path: string, reason: string }>
}

/** 每会话状态容器。 */
export interface TurnrewindUiState {
  bySession: Record<string, TurnrewindSessionState>
}
