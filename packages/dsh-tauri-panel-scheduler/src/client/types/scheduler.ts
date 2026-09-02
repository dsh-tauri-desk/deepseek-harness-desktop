/**
 * types/scheduler.ts — 调度器领域视图类型（客户端投影）。
 */

import type { Translate } from './protocol'

/** 计划类型（与 shared/constants 一致）。 */
export type ScheduleKind = 'daily' | 'interval' | 'workdays' | 'weekly'

/** 星期枚举。 */
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

/** 调度计划（客户端表单形状）。 */
export type ScheduleForm
  = | { kind: 'daily', time: string }
    | { kind: 'interval', everyMinutes: number }
    | { kind: 'workdays', time: string }
    | { kind: 'weekly', weekdays: Weekday[], time: string }

/** 任务视图（列表卡片用）。 */
export interface TaskView {
  id: string
  name: string
  schedule: ScheduleForm & { timeZone?: string }
  prompt: string
  workspaceId?: string
  mode?: string
  module?: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

/** 执行状态。 */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

/** 执行记录视图。 */
export interface RunView {
  id: string
  taskId: string
  taskName: string
  trigger: 'schedule' | 'manual'
  status: RunStatus
  scheduledFor: string
  startedAt: string
  finishedAt?: string
  sessionId?: string
  error?: string
}

/** 新建/编辑任务表单状态。 */
export interface TaskFormState {
  name: string
  schedule: ScheduleForm
  prompt: string
  workspaceId: string
  mode: string
  module: string
}

/** 对话框下拉选项。 */
export interface SchedulerOptions {
  workspaces: Array<{ id: string, path: string, title: string }>
  presets: Array<{ id: string, name: string }>
  models: Array<{ id: string, label: string }>
}

/** 调度器面板 Props（render 注入）。 */
export interface SchedulerPanelProps {
  t: Translate
  /** 「通过 Chat 创建」：关闭面板内容区回到会话区，引导用户直接对 Agent 描述任务。 */
  onViaChat: () => void
}

/** 客户端注入的能力面（由 apis 装配）。 */
export interface SchedulerInjected {
  listTasks: (search?: string) => Promise<{ tasks: TaskView[] }>
  createTask: (input: Record<string, unknown>) => Promise<{ ok: boolean, task?: TaskView, error?: string }>
  updateTask: (id: string, input: Record<string, unknown>) => Promise<{ ok: boolean, task?: TaskView, error?: string }>
  toggleTask: (id: string, enabled: boolean) => Promise<{ ok: boolean, task?: TaskView, error?: string }>
  deleteTask: (id: string) => Promise<{ ok: boolean, error?: string }>
  runTask: (id: string) => Promise<{ ok: boolean, error?: string }>
  listRuns: (taskId?: string) => Promise<{ runs: RunView[] }>
  fetchOptions: () => Promise<SchedulerOptions>
  recover: () => Promise<void>
}
