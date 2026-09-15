import type { CheckoutInfo, OperationResult, PendingHandoff } from '../types'
import { randomUUID } from 'node:crypto'
import { defineService } from 'dsh-tauri'
import { get } from 'lodash-es'
import { getCurrentHostInstance } from '../config/runtime'
import { checkoutContext } from './checkout-context'
import { sessionContext } from './session-context'
import { worktree } from './worktree'

export const handoff = defineService({
  async inherit(
    sourceSessionId: string,
    targetSessionId: string,
    cwd: string,
  ): Promise<OperationResult<{ targetSessionId: string, seedLength: number }>> {
    return createInherited(sourceSessionId, { cwd, parentSession: sourceSessionId, targetSessionId })
  },

  async handback(
    sessionId: string,
    projectPath: string,
    info: CheckoutInfo = {},
  ): Promise<OperationResult<{ targetSessionId: string }>> {
    const targetSessionId = `session-${randomUUID()}`
    const created = await createInherited(sessionId, {
      cwd: projectPath,
      parentSession: sessionId,
      targetSessionId,
      attach: true,
    })
    if (!created.ok)
      return created
    await checkoutContext.save(targetSessionId, {
      projectPath,
      branch: info.branch,
      worktreePath: info.worktreePath,
      checkedOutAt: new Date().toISOString(),
    })
    return { ok: true, targetSessionId }
  },

  async checkout(
    sessionId: string,
    worktreeKey: string,
    branchName: string,
    carryStaged = false,
  ): Promise<OperationResult<{ branch: string, projectPath: string, targetSessionId?: string }>> {
    let targetSessionId: string | undefined
    const checkout = await worktree.checkout(
      { sessionId, worktree_hash_dirname: worktreeKey, branch_name: branchName },
      {
        carryStaged,
        beforeRemove: async (prepared) => {
          const handback = await handoff.handback(sessionId, prepared.projectPath, {
            branch: prepared.branch,
            worktreePath: prepared.worktreePath,
          })
          if (handback.ok)
            targetSessionId = handback.targetSessionId
          return handback
        },
      },
    )
    if (!checkout.ok)
      return checkout
    return { ok: true, branch: checkout.branch, projectPath: checkout.projectPath, targetSessionId }
  },

  async complete(pending: PendingHandoff): Promise<void> {
    const ctx = getCurrentHostInstance()
    const { sourceAgent, targetSessionId, binding } = pending
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
          isSeeded: true,
          seedLength: seed.length,
          ...(parentPreset ? { agentPreset: parentPreset } : {}),
        },
        inheritedEventCount: seed.length,
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
      if (!ctx.agents.get(targetSessionId))
        await worktree.remove(targetSessionId)
      const message = get(error, 'message', String(error))
      ctx.logger?.error?.(`create_worktree handoff failed for ${targetSessionId}: ${message}`)
    }
  },
})

// --- internal ---

async function createInherited(
  sourceSessionId: string,
  options: {
    cwd: string
    parentSession?: string
    attach?: boolean
    targetSessionId?: string
  },
): Promise<OperationResult<{ targetSessionId: string, seedLength: number }>> {
  const ctx = getCurrentHostInstance()
  const agent = ctx.agents?.get?.(sourceSessionId)
  const sourceSession = agent?.session ?? sessionContext.peek(sourceSessionId)
  if (!sourceSession)
    return { ok: false, error: `未找到源会话：${sourceSessionId}` }
  const seed = Array.isArray(sourceSession.events) ? sourceSession.events : []
  if (seed.length === 0)
    return { ok: false, error: `源会话没有可继承的事件：${sourceSessionId}` }

  const { cwd, attach = false } = options
  const targetSessionId = options.targetSessionId ?? `session-${randomUUID()}`
  try {
    const presets = ctx.get?.('agentPresets')
    const parentPreset = agent
      ? (presets?.composedPreset(agent.ctx) ?? sourceSession.header?.agentPreset)
      : sourceSession.header?.agentPreset
    const createOptions: any = {
      sessionId: targetSessionId,
      seed,
      meta: {
        cwd,
        parentSession: options.parentSession ?? sourceSession.id,
        isSeeded: true,
        seedLength: seed.length,
        ...(parentPreset ? { agentPreset: parentPreset } : {}),
      },
      inheritedEventCount: seed.length,
      agentOptions: agent?.options ?? {},
    }
    if (agent && presets && parentPreset) {
      createOptions.setup = (agentCtx: any) => {
        presets.composeFrom(agentCtx, agent.ctx)
      }
    }
    await ctx.agents.create(createOptions)
    if (attach) {
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
      if (workspace)
        await workspace.attachSession(targetSessionId)
    }
    return { ok: true, targetSessionId, seedLength: seed.length }
  }
  catch (error) {
    return { ok: false, error: get(error, 'message', String(error)) }
  }
}
