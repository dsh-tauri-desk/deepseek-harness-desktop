/**
 * host/tools.ts — Agent 自发调用的工作树工具集（create_worktree / checkout_worktree）。
 *
 * create_worktree 只登记 pending handoff；真正把上下文交给新会话发生在
 * turn/end（apply 里的 session:turn-end 钩子），保证 seed 是完整会话日志。
 */

import type { HostContext, PendingHandoff, PluginConfig } from '../types/index.js'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { checkoutToLocal, ensureWorktree } from '../service/operation.js'
import { resolveProjectPath } from '../service/session.js'
import { loadBindingSync } from '../storage/index.js'

/** 文本渲染助手：渲染成模型可见文本。 */
function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}

/** 组装三个工具定义（create_worktree / checkout_worktree / discard_worktree）。 */
export function createToolSet(
  ctx: HostContext,
  config: PluginConfig,
  pendingHandoffs: Map<string, PendingHandoff> = new Map(),
): any[] {
  const worktreesRoot = config.worktreesRoot || join(homedir(), '.dsh')

  return [
    {
      name: 'create_worktree',
      description:
        'Use only when the user explicitly asks to work in a worktree and the current session is local. '
        + 'It creates an isolated worktree and hands the full context to a new session after the current turn. '
        + 'Do not call it from an existing worktree session.',
      parameters: {
        type: 'object',
        properties: {
          branch_name: {
            type: 'string',
            description: 'New worktree branch, for example `dsh/feature-xyz`; the `dsh/` prefix is added when omitted.',
          },
          carry_staged: {
            type: 'boolean',
            description: 'Whether to carry the source repository\'s staged (index) changes into the new worktree, '
              + 'so the isolated session starts from the same staged state. Only staged changes are carried; '
              + 'unstaged and untracked changes stay in the source repository. Default false.',
            default: false,
          },
        },
        required: ['branch_name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            targetSessionId: { type: 'string' },
            worktreePath: { type: 'string' },
            branch: { type: 'string' },
            warning: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args: unknown, value: any) => value.ok
          ? textBlock(`✅ Created worktree ${value.branch}; the UI will switch to the inherited worktree session after this turn.`)
          : textBlock(`❌ Failed to create worktree: ${value.error}`),
      },
      async execute(args: any, exec: any) {
        const sourceAgent = exec?.agent
        const sourceSession = sourceAgent?.session
        if (!sourceAgent || !sourceSession)
          return { ok: false, error: 'create_worktree requires a current agent session' }
        if (loadBindingSync(worktreesRoot, sourceSession.id))
          return { ok: false, error: 'The current session is already in a worktree' }

        const targetSessionId = `session-${randomUUID()}`
        const projectPath = await resolveProjectPath(ctx, sourceSession)
        if (!projectPath)
          return { ok: false, error: '无法解析当前会话的工作目录：会话尚未就绪，请稍后重试' }
        const created = await ensureWorktree(ctx, worktreesRoot, projectPath, targetSessionId, {
          sourceSessionId: sourceSession.id,
          branchName: String(args.branch_name ?? ''),
          carryStaged: args.carry_staged === true,
          signal: exec?.signal,
        })
        if (!created.ok)
          return { ok: false, error: created.error }

        pendingHandoffs.set(sourceSession.id, {
          sourceAgent,
          targetSessionId,
          binding: created.binding,
        })

        return {
          ok: true,
          targetSessionId,
          worktreePath: created.binding.worktreePath,
          branch: created.binding.branchName,
        }
      },
    },
    {
      name: 'checkout_worktree',
      description:
        'User-authorized operation only. Call this tool only after a direct human user explicitly requests or approves checkout. '
        + 'Task completion, a merged PR, or inferred convenience is not permission to call it. When checkout would be a natural next step, '
        + 'such as after a PR is merged, you may ask the user whether they want to check out the worktree; wait for their approval before calling. '
        + 'Bring the current isolated worktree back to the local repository, preserve its changes on the worktree branch, '
        + 'create or switch to the requested local branch, and remove the isolated worktree. The main branch is unchanged.',
      parameters: {
        type: 'object',
        properties: {
          worktree_hash_dirname: {
            type: 'string',
            description: 'Worktree key in `[hash]/[dirname]` form, as shown in the session context.',
          },
          branch_name: {
            type: 'string',
            description: 'Local branch name, such as `dsh/feature-xyz` or `feature-xyz`; used exactly as provided.',
          },
          carry_staged: {
            type: 'boolean',
            description: 'Whether to carry the worktree\'s staged (index) changes into the checked-out local branch '
              + 'before the worktree is removed. Committed work is always carried; staged-only work would otherwise '
              + 'be lost with the removed worktree. Default false.',
            default: false,
          },
        },
        required: ['worktree_hash_dirname', 'branch_name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            branch: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },

        render: (_args: unknown, value: any) => {
          if (!value.ok)
            return textBlock(`❌ Checkout failed: ${value.error}`)
          return textBlock(`✅ Checked out local branch ${value.branch}; the worktree was removed.`)
        },
      },
      async execute(args: any, exec: any) {
        const r = await checkoutToLocal(ctx, worktreesRoot, {
          worktree_hash_dirname: String(args.worktree_hash_dirname ?? ''),
          sessionId: exec?.agent?.session?.id,
          branch_name: String(args.branch_name ?? ''),
        }, {
          signal: exec?.signal,
          carryStaged: args.carry_staged === true,
        })
        if (!r.ok)
          return { ok: false, error: r.error }
        return { ok: true, branch: r.branch, projectPath: r.projectPath }
      },
    },
  ]
}
