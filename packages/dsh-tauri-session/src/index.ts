/**
 * dsh-tauri-session 宿主侧（node half）：「已归档聊天」的管理接口。
 *
 * 归档语义（v2，与官方机制对齐）：
 *   官方工作区浏览器会话行菜单自带「归档」动作，写入宿主 WorkspaceRegistry 的
 *   归档集合（`archivedSessionIds`，持久化、隐藏于所有分组界面、不动工作区记账，
 *   取消归档自动恢复原组原位）。因此本插件不再维护自有的 `archive.json`，
 *   而是直接读写宿主归档集合：
 *     - `GET  /archived`        读宿主归档集合 + 会话头元数据；
 *     - `POST /archive`         归档单个会话（宿主 `archiveSession`）；
 *     - `POST /archive-workspace` 归档一组会话（插件 UI「归档工作区」）；
 *     - `POST /unarchive`       从宿主归档集合移除（宿主无公开 unarchive，
 *                               走注册表内部状态机，见 host/registry.ts）；
 *     - `POST /delete`          彻底删除单个归档会话（归档集合移除 + 物理删除会话数据）；
 *     - `POST /clear`           彻底删除全部已归档会话（同上，批量）。
 *   插件初始化时把旧版自持 `archive.json` 的记录一次性迁入宿主集合后删除旧文件。
 *
 * 三层目录（host / client / shared）：
 *   - index.ts（本文件）  public barrel（公开面不变）；
 *   - shared/constants   跨 half 协议常量（插件名 / API 前缀 / 分区顺序）；
 *   - host/              Node half：session-files（会话定位与文件）/ registry
 *                        （归档集合状态机 + 删除事务）/ archive（归档业务 +
 *                         删除事务一致性）/ storage（unstorage 旧归档持久化）/
 *                        hooks（hookable 归档钩子）/ route / apply；
 *   - client/            Browser half（ofetch RPC + 设置分区 + 工作区补丁）。
 */

import { SESSION_API_PREFIX, SESSION_PLUGIN_NAME } from './shared/constants.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = SESSION_PLUGIN_NAME

/** 需要的宿主服务：webServer（HTTP 路由）、sessions（会话枚举/header）、workspaceRegistry（归档集合）。 */
export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'connection']

/** API 路由前缀（客户端同源 fetch）。 */
export const API_PREFIX = SESSION_API_PREFIX

export { apply } from './host/apply.js'
export { archiveHooks } from './host/hooks/index.js'
export type { ArchiveLifecycleHooks } from './host/hooks/index.js'
export { buildRoutes } from './host/routes/index.js'
export { updateRegistryArchiveSet } from './host/service/registry.js'
export { encodeSessionId, isWithinSessionsRoot } from './host/service/session-files.js'
