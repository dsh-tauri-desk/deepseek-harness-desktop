/**
 * dsh-tauri-turnrewind — turn 级工作区快照与一键撤销。
 *
 * 每个 Agent turn 在私有 Git 快照仓（`$DSH_HOME/<feature>/workspaces/<hash>.git`）记录
 * before / after 两个快照、算出逐文件 `+N -M` 并写入每会话账本；客户端在 turn 尾部渲染
 * 变更卡片并支持一键撤销。对用户仓库全程只读（HEAD / 分支 / index / stash 零污染）。
 *
 * 宿主服务只声明两代内核都提供的服务：webServer（路由）、sessions（会话查找）、
 * agents（turn 事件源）、connection（路由工具读 `ctx.connection` 判定连接信任边界；
 * 该服务必须进 inject，否则 cordis 在请求期抛 `cannot get property without inject`）。
 */

import { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME } from './shared/constants'

export const name = TURNREWIND_PLUGIN_NAME

export const inject = ['webServer', 'sessions', 'agents', 'connection']

export const API_PREFIX = TURNREWIND_API_PREFIX

export { apply } from './host/apply'
