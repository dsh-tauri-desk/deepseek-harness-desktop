import type { StartupPhase } from './readiness'

/** 安装/启动流程阶段状态 */
export type SetupStatus = 'checking' | 'installing' | 'starting' | 'preinstall' | 'ready' | 'error'

/** 侧边栏忙碌标记：标识当前正在执行的服务操作 */
export type SidebarBusyAction = 'restart' | 'shutdown' | 'start' | 'openBrowser' | null

/** Rust 侧 harness-process-exited 事件载荷（camelCase）。 */
export interface HarnessProcessExitedPayload {
  pid: number
  exitCode: number | null
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

/**
 * 启动失败错误：附带从 dsh 服务日志中读取的真实错误行与可选的冲突提示。
 * 由 `utils.startupError` 构造，`utils.attachStartupDiagnostics` 补齐诊断字段。
 */
export interface StartupError extends Error {
  logs?: string[]
  /** 完整清洗后的日志尾（供插件异常定位使用，非仅错误行） */
  logLines?: string[]
  pluginConflictHint?: string
  /** Linux inotify 文件监视上限（ENOSPC）导致服务启动即崩溃时的针对性提示 */
  inotifyLimitHint?: string
  phase?: StartupPhase
  lastReason?: string
}
