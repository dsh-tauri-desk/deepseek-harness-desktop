import { createHooks } from 'hookable'

/** 插件对外可扩展的生命周期钩子（业务状态落定后触发）。 */
export interface TurnRewindHooks {
  /** 某 turn 的 after 快照与差异已写入账本（fileCount 为受影响文件数）。 */
  'turn:captured': (sessionId: string, turn: number, fileCount: number) => void
}

export const turnrewindHooks = createHooks<TurnRewindHooks>()
