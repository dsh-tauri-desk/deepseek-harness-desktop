export type ScheduleKind = 'once' | 'hourly' | 'daily' | 'interval' | 'workdays' | 'weekly' | 'monthly' | 'custom'

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'

export type ScheduleForm
  = | { kind: 'once', at: string }
    | { kind: 'hourly', minute: number }
    | { kind: 'daily', time: string }
    | { kind: 'interval', everyMinutes: number, anchor?: string }
    | { kind: 'workdays', time: string }
    | { kind: 'weekly', weekdays: readonly Weekday[], time: string }
    | { kind: 'monthly', day: number, time: string }
    | { kind: 'custom', everyDays: number, anchor?: string, time: string }

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
  efforts: readonly ModelReasoningEffort[]
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

export interface TaskView {
  id: string
  name: string
  schedule: ScheduleForm & { timeZone?: string }
  prompt: string
  recommendationId?: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  module?: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'cancelled'

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

export interface TaskFormState {
  name: string
  schedule: ScheduleForm
  prompt: string
  workspaceId: string
  permission: string
  provider: string
  model: string
  reasoningEffort: string
}

export interface SchedulerOptions {
  workspaces: readonly { id: string, path: string, title: string }[]
  permissions: readonly PermissionOption[]
  defaultPermission: string
  models: readonly ModelOption[]
  failures: readonly ModelCatalogFailure[]
  defaultModel: ModelOption | null
}

export interface TaskInput {
  name: string
  schedule: ScheduleForm
  prompt: string
  workspaceId?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  recommendationId?: string
  enabled?: boolean
}
