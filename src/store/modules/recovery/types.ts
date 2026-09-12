/** Rust 侧 service::plugin::recovery::PluginRecoveryInfo 的序列化形态（camelCase） */
export interface PluginRecoveryInfo {
  /** 定位到的问题插件（npm 包名）；未定位到时为空 */
  plugins: string[]
  /** 失败原因判别键：duplicate_route / duplicate_loader_entry / cannot_resolve_bundle / no_dsh_bundle / slot_conflict / load_failed / runtime / unknown */
  reason: string
  /** 动态详情（冲突路由 / 槽位 / 服务组件 id），用于 I18n 插值 */
  detail: string
  /** 原始错误信息（技术详情查看） */
  raw_error: string
}

/** 插件异常修复界面状态 */
export interface RecoveryState {
  /** 是否弹出修复界面 */
  required: boolean
  /** 定位到的恢复信息 */
  info: PluginRecoveryInfo | null
  /** 已触发修复的次数（用于防死循环） */
  attempts: number
  /** 修复动作进行中 */
  busy: boolean
}

/** 修复界面的自动提示次数上限：达到后转为「查看日志 / 手动卸载」提示 */
export const MAX_RECOVERY_ATTEMPTS = 3
