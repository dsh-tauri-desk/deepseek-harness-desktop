import type { RecoveryState } from './types'

/** 修复界面的初始状态；`attempts` 可保留以延续「连续失败」计数 */
export function createRecovery(attempts = 0): RecoveryState {
  return {
    required: false,
    info: null,
    attempts,
    busy: false,
  }
}
