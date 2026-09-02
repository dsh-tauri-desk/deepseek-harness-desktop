/**
 * dsh-tauri-panel-scheduler 宿主侧（node half）：定时任务调度器。
 *
 * 三层目录（host / client / shared）：
 *   - index.ts（本文件）  public barrel：公开面（name/inject/apply + 领域能力）；
 *   - shared/constants.ts 跨 half 协议常量（插件名 / API 前缀 / 计划类型）；
 *   - host/               Node half：apply（装配）/ hooks（hookable 生命周期）/
 *                         routes（HTTP）/ storage（unstorage 原子持久化）/ service
 *                         （schedule 计划计算 / scheduler 引擎 / executor 执行 /
 *                         manager CRUD / options 选项）/ tools（agent 工具）。
 *
 * 职责：
 *   1. 存储定时任务定义与执行记录（~/.dsh/dsh-tauri-panel-scheduler/）；
 *   2. 自建调度引擎（宿主即 Node，setInterval 节拍）按计划触发到期任务；
 *   3. 每次执行创建独立 Agent 会话 + followup 任务指令（无人值守）；
 *   4. 注册 scheduler_create/list/toggle/delete/run_now 工具（通过 Chat 创建）；
 *   5. 暴露 /api/dsh-scheduler/* 给客户端（list/create/update/toggle/delete/run/
 *      history/options）。
 */

import { SCHEDULER_API_PREFIX, SCHEDULER_PLUGIN_NAME } from './shared/constants.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = SCHEDULER_PLUGIN_NAME

/**
 * 需要的宿主服务（对齐 MichengAI/dsh-automation 的 inject，另加我们路由用的
 * webServer）：tools（工具注册）/ webServer（HTTP 路由）/ agents（会话执行）/
 * sessions（会话 flush 持久化——工作区侧边栏收录会话的前提）/ workspaceRegistry
 * （工作区归属）/ agentDefaultModel（默认模型回退）/ agentPresets（会话预设挂载）/
 * permissionPresets（无人值守权限）/ llm（模型目录）/ connection（连接鉴权）。
 */
export const inject = [
  'tools',
  'webServer',
  'agents',
  'sessions',
  'workspaceRegistry',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'llm',
  'connection',
]

/** API 路由前缀（客户端同源 fetch）。 */
export const API_PREFIX = SCHEDULER_API_PREFIX

export { apply } from './host/apply.js'
export type { Config } from './host/apply.js'
export { createSchedulerHooks } from './host/hooks/index.js'
export type { SchedulerLifecycleHooks } from './host/hooks/index.js'
export { buildRoutes } from './host/routes/index.js'
export { executeTask } from './host/service/executor.js'
export { localTimeZone, nextOccurrence, parseTimeToMinutes, validateSchedule } from './host/service/schedule.js'
export { SchedulerEngine } from './host/service/scheduler.js'
export { createToolSet } from './host/tools/index.js'
export type { SchedulerOptions, SchedulerRun, SchedulerSchedule, SchedulerTask } from './host/types/index.js'
export { SCHEDULE_KINDS, SCHEDULER_API_PREFIX, WEEKDAYS, WORKDAY_SET } from './shared/constants.js'
