/**
 * host/apply.ts — 工作树插件装配（tools 注册 / session:turn-end 钩子 / 系统提示注入 /
 * 旧版本遗留自愈 / HTTP 路由）。
 *
 * 装配顺序与 reasons：
 *   1. 工具注册先于事件监听——turn/end 到达时 handoff 表已就绪；
 *   2. session/event 只作转发，行为经 hookable 钩子接线（见 hooks.ts）；
 *   3. 系统提示只在相关会话组装时按 binding 实时计算；
 *   4. HTTP 路由注册在 effect 内，卸载统一释放。
 */

import type { HostContext, PendingHandoff, PluginConfig } from './types.js'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { WORKTREE_SECTION_ORDER } from '../shared/constants.js'
import { completeWorktreeHandoff } from './handoff.js'
import { createWorktreeHooks } from './hooks.js'
import { unregisterWorktreeWorkspace, worktreeKey } from './operation.js'
import { buildRoutes } from './route.js'
import {
  clearPendingCheckoutContext,
  loadCheckoutContextsSync,
  loadLedgerSync,
} from './storage.js'
import { createToolSet } from './tools.js'

/**
 * 插件体：注册工具、HTTP 路由与系统提示注入。
 * @param ctx - 客户端根上下文（注入 tools/systemPrompt/webServer/sessions/workspaceRegistry）。
 * @param config - 插件行配置（worktreesRoot 等）。
 */
export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const cfg = config ?? {}
  const worktreesRoot = typeof cfg.worktreesRoot === 'string' && cfg.worktreesRoot
    ? cfg.worktreesRoot
    : join(homedir(), '.dsh')

  // 生命周期钩子：会话 turn/end 挂为命名钩子（hookable），apply 只做事件转发。
  const hooks = createWorktreeHooks()
  // 1) 工具注册。create_worktree 的交接延迟到源 turn/end，确保 seed 是完整日志。
  const pendingHandoffs = new Map<string, PendingHandoff>()
  // 只有 provider 确实参与过模型组装的会话，才允许在 turn/end 消费一次性上下文。
  // 新继承会话发布、列表同步或其他空转事件不能提前清除它。
  const injectedCheckoutContexts = new Set<string>()
  for (const tool of createToolSet(ctx, cfg, pendingHandoffs)) {
    ctx.tools.register(tool)
  }
  hooks.hook('session:turn-end', (session, _event) => {
    const handoff = pendingHandoffs.get(session.id)
    if (handoff) {
      pendingHandoffs.delete(session.id)
      void completeWorktreeHandoff(ctx, worktreesRoot, handoff)
    }
    // 仅当 systemPrompt.context provider 已实际返回过检出信息，才在该轮结束后消费。
    // 否则新会话发布时出现的既有/空转 turn/end 会在用户首条消息前误删上下文。
    if (injectedCheckoutContexts.delete(session.id))
      void clearPendingCheckoutContext(worktreesRoot, session.id)
  })
  ctx.on('session/event', (session: any, event: any) => {
    if (event.type !== 'turn/end')
      return
    void hooks.callHook('session:turn-end', session, event)
  })

  // 2) 自愈旧版本遗留：只注销普通 Workspace 记录，不删除工作树或会话。
  ctx.effect(() => {
    const ledger = loadLedgerSync(worktreesRoot)
    void Promise.all(Object.values(ledger).map(binding => unregisterWorktreeWorkspace(ctx, binding.worktreePath)))
  }, 'dsh-tauri-worktree: unregister legacy worktree workspaces')

  // 3) 检出后的第一条用户消息：作为 DSH dynamic runtime context 注入，而不是
  // 主动 followup 启动额外 turn。目标会话的 header.cwd 已绑定 projectPath。
  ctx.systemPrompt.context({
    name: 'plugin:dsh-tauri-worktree:checkout',
    order: WORKTREE_SECTION_ORDER,
    text: (context: any) => {
      const sessionId = context?.scope?.session?.id
      if (!sessionId)
        return ''
      const checkout = loadCheckoutContextsSync(worktreesRoot)[sessionId]
      if (!checkout)
        return ''
      injectedCheckoutContexts.add(sessionId)
      return (
        `Worktree checkout completed.\n`
        + `is_worktree: false\n`
        + `Removed worktree: ${checkout.worktreePath ?? 'unknown'}\n`
        + `Current local project directory: ${checkout.projectPath}\n`
        + `Current local branch: ${checkout.branch ?? 'unknown'}\n\n`
        + `Continue this request in the local project directory. Do not use the removed worktree path.`
      )
    },
  })

  // 4) 系统提示注入：处于工作树时会话的上下文标记 is_worktree: true。
  ctx.systemPrompt.section({
    name: 'plugin:dsh-tauri-worktree',
    order: WORKTREE_SECTION_ORDER,
    // 每次组装按调用作用域重算：scope 是该 Agent 时读其会话的绑定状态。
    text: (context: any) => {
      const session = context?.scope?.session
      const sessionId = session?.id
      if (!sessionId)
        return ''
      const ledger = loadLedgerSync(worktreesRoot)
      const binding = ledger[sessionId]
      if (!binding)
        return ''
      return (
        `This session is running in an isolated worktree.\n`
        + `is_worktree: true\n`
        + `Worktree key: ${worktreeKey(binding.hash, binding.dirname)}\n`
        + `Worktree path: ${binding.worktreePath}\n`
        + `Project path: ${binding.projectPath}\n\n`
        + `Make code changes inside the bound worktree and use its path as the shell workdir. `
        + `The worktree contains only tracked files: node_modules and generated build dirs are not carried over, `
        + `so if the project needs its dependencies, run the package manager install (e.g. \`pnpm install\`) inside the worktree first. `
        + `checkout_worktree is user-authorized only: call it only after a direct human user explicitly requests or approves checkout. `
        + `Task completion, a merged PR, or inferred convenience is not permission to call it. When checkout would be a natural next step, `
        + `such as after a PR is merged, you may ask the user whether they want to check out the worktree; wait for their approval before calling.`
      )
    },
  })

  // 5) HTTP 路由注册（客户端 UI 经此调用 create/status/checkout/discard）。
  ctx.effect(() => {
    const disposers = buildRoutes(ctx, cfg).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
