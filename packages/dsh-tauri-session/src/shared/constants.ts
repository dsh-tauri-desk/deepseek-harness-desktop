/** shared/constants.ts — 跨 host/client 的稳定协议常量（session 归档管理）。 */

/** 插件名（诊断元数据 / registrant）。 */
export const SESSION_PLUGIN_NAME = 'dsh-tauri-session'

/** HTTP 路由前缀（host route + client rpc 同源 fetch）。 */
export const SESSION_API_PREFIX = '/api/dsh-session'

/** 归档设置分区的导航顺序（settings.section 槽）。 */
export const SESSION_SECTION_ORDER = 220
