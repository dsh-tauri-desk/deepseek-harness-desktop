/** 安装/启动流程阶段状态 */
export type SetupStatus = 'checking' | 'installing' | 'starting' | 'preinstall' | 'ready' | 'error'

/** 侧边栏忙碌标记：标识当前正在执行的服务操作 */
export type SidebarBusyAction = 'restart' | 'shutdown' | 'start' | 'openBrowser' | null

/** 预装插件列表项（与 Rust service::plugin::PreinstallPlugin 对齐） */
export interface PreinstallPlugin {
  id: string
  name: string
  description: string
  repo_url: string
  recommended: boolean
  /** “修复”类项（Windows 极简模式修复）：黄色 chip，默认勾选 */
  fix: boolean
  /** 无 chip 但默认勾选（首次引导直接勾上，不标「推荐」） */
  defaultChecked: boolean
  installed: boolean
}

/** Rust 侧 preinstall-log 事件载荷（dsh plugin 进程输出行） */
export interface PreinstallLogPayload {
  line: string
}

/** Rust 侧 internal-plugins-phase 事件载荷（内置插件核对/安装进度与 heartbeat） */
export const INTERNAL_PLUGIN_PHASE_DETAILS = [
  'waiting',
  'checking',
  'installing',
  'heartbeat',
  'done',
  'timeout',
  'cancelled',
] as const

export type InternalPluginPhaseDetail = typeof INTERNAL_PLUGIN_PHASE_DETAILS[number]

export interface InternalPluginsPhasePayload {
  phase: 'loading' | 'progress' | 'done'
  detail: InternalPluginPhaseDetail
  completed: number
  total: number
}

/** 安装器展示状态 */
export interface InstallerState {
  title: string
  detail: string
  percentage: number
  logs: string[]
}

/** Rust 侧 install-progress 事件载荷 */
export interface InstallProgress {
  title: string
  detail: string
  log: string
  type: string
  percentage: number
  progress: number
}

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
