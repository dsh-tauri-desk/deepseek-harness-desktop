/** client/constants/index.ts — 客户端共享常量（跨 half 协议常量见 shared/constants.ts）。 */

import { SCHEDULER_PLUGIN_NAME } from '../../shared/constants'

export { SCHEDULER_API_PREFIX as API_PREFIX, SCHEDULER_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export const LOCALE_NAMESPACE = SCHEDULER_PLUGIN_NAME

export const PANEL_PROTOCOL_NAME = 'panel.protocol'
export const PANEL_SLOT_NAME = 'sidebar.panel.action'
export const PANEL_ID = 'dsh-tauri-panel-scheduler'
export const PANEL_ACTION_ID = 'dsh-tauri-panel-scheduler.action'
export const PANEL_ACTION_ORDER = 30
export const PANEL_ACTION_PRIORITY = 0

export const STYLE_ID = 'dsh-tauri-panel-scheduler-styles'

export const STYLES_EFFECT = `${SCHEDULER_PLUGIN_NAME}: styles`
export const PANEL_EFFECT = `${SCHEDULER_PLUGIN_NAME}: panel slot`

/** 客户端轮询刷新间隔（执行记录 / 下次运行时间跟随）。 */
export const REFRESH_INTERVAL_MS = 5_000
/** 协议未就绪时的重试间隔。 */
export const PROTOCOL_RETRY_MS = 50
