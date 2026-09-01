/**
 * handoff.ts — 工作树会话的「交接」：把工作树会话的完整对话历史带回本地仓库
 * （继承会话 seed），以及 create_worktree 工具在 turn/end 后的自动交接。
 *
 * 时序约束：继承会话必须在归档/删除工作树**之前**创建成功（beforeRemove 钩子），
 * 否则用户会看到「变成新会话、会话信息全部丢失」；create_worktree 的交接则必须
 * 延迟到源 turn/end，保证 seed 是平衡的完整会话日志。
 */

import type {
  CheckoutInfo,
  CheckoutOptions,
  HostContext,
  OperationResult,
  PendingHandoff,
  WorktreeParams,
} from './types.js'
import { randomUUID } from 'node:crypto'
import { checkoutToLocal, discardWorktree } from './operation.js'
import { findSession } from './session.js'
import { setPendingCheckoutContext } from './storage.js'

/**
 * 把工作树会话的完整对话历史带回本地仓库：以工作树会话的全部事件为 seed 创建
 * 继承会话，cwd 指向本地项目路径，并归属源 Workspace。
 *
 * 背景：UI「检出本地」完成后会归档工作树会话。若只是打开 ledger 里的源会话，
 * 界面流程（模式选择器迁移草稿）创建的源会话是空白会话（0 轮对话），归档后用户
 * 会看到「变成新会话、会话信息全部丢失」。本函数在归档前先创建继承会话，保证
 * 检出后仍能看到并继续完整对话。
 *
 * @param ctx 宿主根上下文
 * @param worktreesRoot 工作树根目录
 * @param sessionId 工作树会话 id（其事件将被继承）
 * @param projectPath 检出后的本地项目路径（新会话 cwd）
 * @param checkoutInfo 首条消息的一次性检出上下文
 * @returns 继承会话 id（创建失败时 ok=false）
 */
export async function handbackWorktreeSession(
  ctx: HostContext,
  worktreesRoot: string,
  sessionId: string,
  projectPath: string,
  checkoutInfo: CheckoutInfo = {},
): Promise<OperationResult<{ targetSessionId: string }>> {
  const agent = ctx.agents?.get?.(sessionId)
  const sourceSession = agent?.session ?? findSession(ctx, sessionId)
  if (!sourceSession)
    return { ok: false, error: `未找到工作树会话：${sessionId}` }
  const targetSessionId = `session-${randomUUID()}`
  try {
    const presets = ctx.get?.('agentPresets')
    const parentPreset = agent
      ? (presets?.composedPreset(agent.ctx) ?? sourceSession.header?.agentPreset)
      : sourceSession.header?.agentPreset
    const seed = Array.isArray(sourceSession.events) ? sourceSession.events : []
    const options: any = {
      sessionId: targetSessionId,
      seed,
      meta: {
        cwd: projectPath,
        parentSession: sourceSession.id,
        seedLength: seed.length,
        ...(parentPreset ? { agentPreset: parentPreset } : {}),
      },
      agentOptions: agent?.options ?? {},
    }
    if (agent && presets && parentPreset) {
      // setup may return a transaction; do not leak composeFrom()'s preset id.
      options.setup = (agentCtx: any) => {
        presets.composeFrom(agentCtx, agent.ctx)
      }
    }
    await ctx.agents.create(options)
    const workspace = await ctx.workspaceRegistry.resolveByPath(projectPath)
    if (workspace)
      await workspace.attachSession(targetSessionId)
    await setPendingCheckoutContext(worktreesRoot, targetSessionId, {
      projectPath,
      branch: checkoutInfo.branch,
      worktreePath: checkoutInfo.worktreePath,
      checkedOutAt: new Date().toISOString(),
    })
    return { ok: true, targetSessionId }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 检出本地（UI 流程）：本地分支切换后、删除工作树之前，先用本地 cwd 创建新会话，
 * 并把工作树会话的完整事件作为 seed 覆盖过去。只有新会话创建成功才删除工作树。
 *
 * @param ctx 宿主根上下文
 * @param worktreesRoot 工作树根目录
 * @param params 检出参数（worktree_hash_dirname / sessionId / branch_name）
 * @param opts 选项（signal / carryStaged）
 * @returns 检出 + 带回结果
 */
export async function checkoutToLocalAndHandback(
  ctx: HostContext,
  worktreesRoot: string,
  params: WorktreeParams,
  opts: CheckoutOptions = {},
): Promise<OperationResult<{ branch: string, projectPath: string, targetSessionId?: string }>> {
  const sessionId = String(params.sessionId ?? '')
  let targetSessionId
  const checkout = await checkoutToLocal(ctx, worktreesRoot, params, {
    ...opts,
    beforeRemove: async (prepared) => {
      const handback = await handbackWorktreeSession(ctx, worktreesRoot, sessionId, prepared.projectPath, {
        branch: prepared.branch,
        worktreePath: prepared.worktreePath,
      })
      if (handback.ok)
        targetSessionId = handback.targetSessionId
      return handback
    },
  })
  if (!checkout.ok)
    return checkout
  return { ok: true, branch: checkout.branch, projectPath: checkout.projectPath, targetSessionId }
}

/**
 * turn/end 后完成工作树会话交接。此时 sourceSession.events 已包含触发工具的完整 turn，
 * 可安全作为新会话 seed；在开放 turn 内复制会得到不平衡的会话日志。
 */
export async function completeWorktreeHandoff(
  ctx: HostContext,
  worktreesRoot: string,
  handoff: PendingHandoff,
): Promise<void> {
  const { sourceAgent, targetSessionId, binding } = handoff
  const sourceSession = sourceAgent.session
  try {
    const presets = ctx.get?.('agentPresets')
    const parentPreset = presets?.composedPreset(sourceAgent.ctx) ?? sourceSession.header.agentPreset
    const seed = sourceSession.events
    const handle = await ctx.agents.create({
      sessionId: targetSessionId,
      seed,
      meta: {
        cwd: binding.worktreePath,
        parentSession: sourceSession.id,
        seedLength: seed.length,
        ...(parentPreset ? { agentPreset: parentPreset } : {}),
      },
      agentOptions: sourceAgent.options ?? {},
      setup: (agentCtx: any) => {
        if (presets && parentPreset)
          presets.composeFrom(agentCtx, sourceAgent.ctx)
      },
    })
    const workspace = await ctx.workspaceRegistry.resolveByPath(binding.projectPath)
    if (workspace)
      await workspace.attachSession(targetSessionId)
    handle.agent.followup({
      id: `message-${randomUUID()}`,
      role: 'user',
      content: [{
        type: 'text',
        text: 'The task has moved to an isolated worktree session. Continue the user request from the inherited context without explaining the handoff again.',
      }],
      source: { kind: 'user' },
    })
  }
  catch (error) {
    // 未发布时可以完整回滚；已发布时保留工作树，避免正在运行的新会话丢失 cwd。
    if (!ctx.agents.get(targetSessionId)) {
      await discardWorktree(ctx, worktreesRoot, { sessionId: targetSessionId })
    }
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`create_worktree handoff failed for ${targetSessionId}: ${message}`)
  }
}
