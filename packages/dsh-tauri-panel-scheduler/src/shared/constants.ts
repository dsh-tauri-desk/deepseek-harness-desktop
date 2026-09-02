/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量（dsh-tauri-panel-scheduler）。
 *
 * API 前缀与插件名是两半端共享的线协议面：host 路由注册、client RPC 各自硬编码
 * 会漂移，集中在此由两端共同引用（host/constants.ts 与 client/constants.ts 消费）。
 */

/** 插件名（诊断元数据 / registrant / storage key 前缀）。 */
export const SCHEDULER_PLUGIN_NAME = 'dsh-tauri-panel-scheduler'

/** HTTP 路由前缀（host route + client rpc 同源 fetch）。 */
export const SCHEDULER_API_PREFIX = '/api/dsh-scheduler'

/** 计划类型集合（与 DSH automation 工具的语义一一对应）。 */
export const SCHEDULE_KINDS = ['daily', 'interval', 'workdays', 'weekly'] as const

/** 星期枚举（IATA 三字母，与 DSH automation 一致）。 */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

/** 工作日（周一至周五）。 */
export const WORKDAY_SET: ReadonlySet<string> = new Set(['MO', 'TU', 'WE', 'TH', 'FR'])
