/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量。
 *
 * API 前缀与插件名是两半端共享的线协议面：host 路由注册、client RPC 各自硬编码
 * 会漂移，集中在此由两端共同引用（host/constants.ts 与 client/constants.ts 消费）。
 */

/** 插件名（诊断元数据 / registrant / storage key 前缀）。 */
export const WORKTREE_PLUGIN_NAME = 'dsh-tauri-worktree'

/** HTTP 路由前缀（host route + client rpc 同源 fetch）。 */
export const WORKTREE_API_PREFIX = '/api/dsh-worktree'

/** 系统提示注入顺序（context/section 共用）。 */
export const WORKTREE_SECTION_ORDER = 210
