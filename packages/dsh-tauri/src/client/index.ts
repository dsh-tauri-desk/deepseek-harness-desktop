/**
 * dsh-tauri 客户端 barrel（browser half）：插件入口 + 全 workspace 客户端共享工具。
 *
 * 共享工具（供各插件 client 导入 `dsh-tauri/client`）：
 *   - compat / resolveStartSession：Alpha ↔ rc.2 服务布局适配；
 *   - store：框架无关 SnapshotStore（uSES 安全）；
 *   - http：ofetch 统一 JSON 客户端（requestJson / createJsonClient）；
 *   - controller：hookable 生命周期控制器（observer/timer/listener 收敛）；
 *   - CssRender：css-render 样式树（各插件 mount*Styles 使用）。
 */
import { PLUGIN_ID, PLUGIN_INJECT } from './constants'

/** 插件显示名（诊断元数据）。 */
export const name = PLUGIN_ID

/** 需要的客户端服务：layout（侧边栏切换）。 */
export const inject = PLUGIN_INJECT

export * from './apis'
export { apply } from './apply'
export * from './controller'
export * from './storage'
export * from './store'
export type * from './types'

export type { ClientContext } from './types'
export { compat, resolveStartSession } from './utils/compat'
export { CssRender } from 'css-render'

/**
 * date-fns（客户端时间格式化）由 dsh-tauri 承载并内联进其 client bundle；
 * 插件 client 禁止直接 import 'date-fns'，一律从本 barrel（`dsh-tauri/client`）导入。
 */
export { differenceInDays, differenceInHours, differenceInMinutes, format } from 'date-fns'

export { createHooks } from 'hookable'
