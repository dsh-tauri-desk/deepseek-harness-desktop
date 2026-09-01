/**
 * dsh-tauri-worktree 宿主侧（node half）：会话级 Git Worktree 隔离。
 *
 * 三层目录（host / client / shared，参照 vite-plugin-inspect 的运行时边界）：
 *   - index.ts（本文件）  public barrel：公开面（name/inject/API_PREFIX/apply/领域能力）；
 *   - shared/constants.ts 跨 half 协议常量（插件名 / API 前缀 / 系统提示顺序）；
 *   - host/               Node half 领域（apply 装配 / tools / git / storage(unstorage) /
 *                         operation / handoff / route / session / hooks(hookable)）；
 *   - client/             Browser half（RPC(ofetch) / 共享状态 / 控制器(hookable) /
 *                         特性组件），经 /api/dsh-worktree/* 与本 half 通信。
 *
 * 职责：
 *   1. 根据「项目路径 + 会话 ID」计算唯一 hash，在 `~/.dsh/worktrees/[hash]/[dirname]`
 *      用 `git worktree add --detach` 创建隔离工作树；
 *   2. 维护 per-session 绑定（WeakMap 活对象 + 磁盘 ledger 持久化）；
 *   3. 注册 `create_worktree` / `checkout_worktree` / `discard_worktree` 工具（Agent 自发调用）；
 *   4. 系统提示注入 `is_worktree: true`；
 *   5. 暴露 /api/dsh-worktree/* 给客户端（create / status / checkout / discard）。
 *
 * 检出语义（已与用户确认）：「检出本地」= 在工作树分支上保留全部改动，在本地仓库
 * 创建/切换到 `dsh/<branch>` 分支，Agent 继续在本地仓库工作；主分支不受影响。
 */

import { WORKTREE_API_PREFIX, WORKTREE_PLUGIN_NAME } from './shared/constants.js'

/** 插件名（诊断元数据，与导出的 name 一致）。 */
export const name = WORKTREE_PLUGIN_NAME

/**
 * 需要的宿主服务：
 *   tools            工具注册表（注册 create_worktree / checkout_worktree / discard_worktree）
 *   systemPrompt     系统提示注入（is_worktree: true）
 *   webServer        HTTP 路由（/api/dsh-worktree/*，客户端经此调用）
 *   sessions         当前会话枚举/查找（绑定工作树）
 *   workspaceRegistry注册工作树为 DSH 工作区（可选，增强归类）
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions', 'workspaceRegistry', 'agents', 'connection']

/** API 路由前缀（客户端同源 fetch）。 */
export const API_PREFIX = WORKTREE_API_PREFIX

export { apply } from './host/apply.js'
export { checkoutToLocalAndHandback, completeWorktreeHandoff } from './host/handoff.js'
export { createWorktreeHooks } from './host/hooks.js'
export type { WorktreeLifecycleHooks } from './host/hooks.js'
export { computeHash, worktreeKey, worktreePath } from './host/operation.js'
export { checkoutToLocal, discardWorktree, ensureWorktree } from './host/operation.js'
export { buildRoutes } from './host/route.js'
export { createToolSet } from './host/tools.js'
