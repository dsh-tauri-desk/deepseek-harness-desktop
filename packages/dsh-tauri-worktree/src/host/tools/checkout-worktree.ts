import { get } from 'lodash-es'
import { worktree } from '../service/worktree'

export function checkoutWorktreeTool(): any {
  return {
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
      render: (_args: unknown, value: any) => value.ok
        ? textBlock(`✅ Checked out local branch ${value.branch}; the worktree was removed.`)
        : textBlock(`❌ Checkout failed: ${value.error}`),
    },
    async execute(args: any, exec: any) {
      const result = await worktree.checkout(
        {
          worktree_hash_dirname: String(args.worktree_hash_dirname ?? ''),
          sessionId: get(exec, 'agent.session.id'),
          branch_name: String(args.branch_name ?? ''),
        },
        {
          signal: exec?.signal,
          carryStaged: args.carry_staged === true,
        },
      )
      if (!result.ok)
        return { ok: false, error: result.error }
      return { ok: true, branch: result.branch, projectPath: result.projectPath }
    },
  }
}

function textBlock(text: string): Array<{ type: 'text', text: string }> {
  return [{ type: 'text', text }]
}
