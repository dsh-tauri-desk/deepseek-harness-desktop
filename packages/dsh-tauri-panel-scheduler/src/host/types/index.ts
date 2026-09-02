/**
 * host/types/index.ts — 调度器宿主侧类型。
 *
 * 领域数据模型（SchedulerTask / SchedulerRun / SchedulerSchedule）是 host 与 client
 * 共用的线协议形状：client 侧另有视图投影（client/types/），本文件保持纯数据模型。
 */

import type { SCHEDULE_KINDS, WEEKDAYS } from '../../shared/constants.js'

/** 宿主根上下文（Cordis 注入能力；插件侧以 any 消费，类型由 dsh 生态 declare module 增强）。 */
export type HostContext = any

/** 插件行配置。 */
export interface PluginConfig {
  /** 调度 tick 间隔（毫秒）。 */
  tickMs?: number
}

/** 计划类型（每天/间隔/工作日/每周）。 */
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

/** 星期枚举（IATA 三字母）。 */
export type Weekday = (typeof WEEKDAYS)[number]

/** 每天：`time` 为 "HH:mm"（timeZone 时区）。 */
export interface DailySchedule {
  kind: 'daily'
  time: string
  timeZone: string
}

/** 间隔：每 everyMinutes 分钟执行一次（timeZone 供展示/锚点对齐）。 */
export interface IntervalSchedule {
  kind: 'interval'
  everyMinutes: number
  timeZone: string
}

/** 工作日（周一至周五）：`time` 为 "HH:mm"。 */
export interface WorkdaysSchedule {
  kind: 'workdays'
  time: string
  timeZone: string
}

/** 每周：weekdays 为选中的星期，`time` 为 "HH:mm"。 */
export interface WeeklySchedule {
  kind: 'weekly'
  weekdays: Weekday[]
  time: string
  timeZone: string
}

/** 调度计划（discriminated union）。 */
export type SchedulerSchedule = DailySchedule | IntervalSchedule | WorkdaysSchedule | WeeklySchedule

/** 任务执行来源。 */
export type RunTrigger = 'schedule' | 'manual'

/** 任务状态。 */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

/** 定时任务定义（持久化于 tasks.json）。 */
export interface SchedulerTask {
  /** 稳定 id。 */
  id: string
  /** 任务名称。 */
  name: string
  /** 调度计划。 */
  schedule: SchedulerSchedule
  /** 任务指令（作为新会话的首条用户消息）。 */
  prompt: string
  /** 目标工作区 id（可空：不指定时使用默认会话 cwd）。 */
  workspaceId?: string
  /** Agent 模式（agentPreset / 访问模式，可空）。 */
  mode?: string
  /** 模块 / 模型（可空：使用默认模型）。 */
  module?: string
  /** 是否启用（paused = false）。 */
  enabled: boolean
  /** 创建时间（ISO）。 */
  createdAt: string
  /** 最近更新时间（ISO）。 */
  updatedAt: string
  /** 最近一次计划触发时间（ISO）。 */
  lastRunAt?: string
  /** 下次计划触发时间（ISO，host 计算并回填）。 */
  nextRunAt?: string
}

/** 单次执行记录（持久化于 runs.json）。 */
export interface SchedulerRun {
  /** 稳定 id。 */
  id: string
  /** 所属任务 id。 */
  taskId: string
  /** 任务名称快照（任务删除后仍可展示）。 */
  taskName: string
  /** 触发来源。 */
  trigger: RunTrigger
  /** 执行状态。 */
  status: RunStatus
  /** 计划触发时间（ISO）。 */
  scheduledFor: string
  /** 实际开始时间（ISO）。 */
  startedAt: string
  /** 结束时间（ISO，终态时存在）。 */
  finishedAt?: string
  /** 执行会话 id（创建成功时存在）。 */
  sessionId?: string
  /** 失败原因（失败/跳过时）。 */
  error?: string
}

/** 持久化文档形状。 */
export interface SchedulerState {
  version: 1
  tasks: SchedulerTask[]
  runs: SchedulerRun[]
}

/** 供对话框/下拉使用的选项。 */
export interface SchedulerOptions {
  workspaces: Array<{ id: string, path: string, title: string }>
  presets: Array<{ id: string, name: string }>
  models: Array<{ id: string, label: string }>
}

/** HTTP 路由结果（dsh-tauri routeHandler 契约）。 */
export type RouteResult = [number, unknown]
export type JsonBody = Record<string, unknown>
