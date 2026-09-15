import type { SCHEDULE_KINDS, WEEKDAYS } from '../../shared/constants'

export type HostContext = any

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export type Weekday = (typeof WEEKDAYS)[number]

export interface OnceSchedule {
  kind: 'once'
  at: string
  timeZone: string
}

export interface HourlySchedule {
  kind: 'hourly'
  minute: number
  timeZone: string
}

export interface DailySchedule {
  kind: 'daily'
  time: string
  timeZone: string
}

export interface IntervalSchedule {
  kind: 'interval'
  everyMinutes: number
  anchor?: string
  timeZone: string
}

export interface WorkdaysSchedule {
  kind: 'workdays'
  time: string
  timeZone: string
}

export interface WeeklySchedule {
  kind: 'weekly'
  weekdays: Weekday[]
  time: string
  timeZone: string
}

export interface MonthlySchedule {
  kind: 'monthly'
  day: number
  time: string
  timeZone: string
}

export interface CustomSchedule {
  kind: 'custom'
  everyDays: number
  anchor: string
  time: string
  timeZone: string
}

export type SchedulerSchedule = OnceSchedule | HourlySchedule | DailySchedule | IntervalSchedule | WorkdaysSchedule | WeeklySchedule | MonthlySchedule | CustomSchedule

export type RunTrigger = 'schedule' | 'manual'

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'cancelled'

export interface SchedulerTask {
  id: string
  name: string
  schedule: SchedulerSchedule
  prompt: string
  recommendationId?: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  module?: string
  agentPreset?: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface SchedulerRun {
  id: string
  taskId: string
  taskName: string
  trigger: RunTrigger
  status: RunStatus
  scheduledFor: string
  startedAt: string
  finishedAt?: string
  sessionId?: string
  error?: string
}

export interface TaskInput {
  name: string
  schedule: SchedulerSchedule
  prompt: string
  recommendationId?: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  enabled?: boolean
}

export interface PermissionOption {
  value: string
  name: string
  description?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelReasoning {
  efforts: Array<ModelReasoningEffort>
  defaultEffort?: string
}

export interface ModelOption {
  provider: string
  providerLabel: string
  model: string
  label: string
  description?: string
  reasoning?: ModelReasoning
}

export interface ModelCatalogFailure {
  provider: string
  providerLabel: string
  message: string
}

export interface SchedulerOptions {
  workspaces: Array<{ id: string, path: string, title: string }>
  permissions: Array<PermissionOption>
  defaultPermission: string
  models: Array<ModelOption>
  failures: Array<ModelCatalogFailure>
  defaultModel: ModelOption | null
}

export type OperationResult<T extends object = object>
  = | ({ ok: true } & T)
    | { ok: false, error: string }
