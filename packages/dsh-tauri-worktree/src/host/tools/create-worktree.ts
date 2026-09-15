import { randomUUID } from 'node:crypto'
import { get, isString } from 'lodash-es'
import { pendingHandoffs } from '../config/runtime'
import { ledger } from '../service/ledger'
import { sessionContext } from '../service/session-context'
import { worktree } from '../service/worktree'

const outputSchema = {
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
}

export function createWorktreeTool(): any {
  return {
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
      schema: outputSchema,
      render: (_args: unknown, value: any) => value.ok
        ? textBlock(`✅ Created worktree ${value.branch}; the UI will switch to the inherited worktree session after this turn.`)
        : textBlock(`❌ Failed to create worktree: ${value.error}`),
    },
    async execute(args: any, exec: any) {
      const sourceSessionId = get(exec, 'agent.session.id')
      if (!isString(sourceSessionId))
        return { ok: false, error: 'create_worktree requires a current agent session' }
      if (ledger.load(sourceSessionId))
        return { ok: false, error: 'The current session is already in a worktree' }

      const projectPath = await sessionContext.resolve(sourceSessionId)
      if (!projectPath)
        return { ok: false, error: '无法解析当前会话的工作目录：会话尚未就绪，请稍后重试' }

      const targetSessionId = `session-${randomUUID()}`
      const created = await worktree.create(projectPath, targetSessionId, {
        sourceSessionId,
        branchName: String(args.branch_name ?? ''),
        carryStaged: args.carry_staged === true,
        signal: exec?.signal,
      })
      if (!created.ok)
        return { ok: false, error: created.error }

      pendingHandoffs.set(sourceSessionId, {
        sourceAgent: get(exec, 'agent'),
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
  }
}

function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}
