import { get, isString } from 'lodash-es'
import { WORKTREE_SECTION_ORDER } from '../../shared/constants'
import { ledger } from '../service/ledger'

export const worktreeSectionProvider = {
  name: 'plugin:dsh-tauri-worktree',
  order: WORKTREE_SECTION_ORDER,
  text(context: any): string {
    const sessionId = get(context, 'scope.session.id')
    if (!isString(sessionId))
      return ''
    const binding = ledger.load(sessionId)
    if (!binding)
      return ''
    return (
      `This session is running in an isolated worktree.\n`
      + `is_worktree: true\n`
      + `Worktree key: ${binding.hash}/${binding.dirname}\n`
      + `Worktree path: ${binding.worktreePath}\n`
      + `Project path: ${binding.projectPath}\n\n`
      + `Make code changes inside the bound worktree and use its path as the shell workdir. `
      + `Dependency directories (e.g. node_modules) are linked from the source repository so the worktree works out of the box. `
      + `Running a package manager install (e.g. \`pnpm install\`) inside the worktree first detaches that link and materializes an independent copy, `
      + `leaving the source repository untouched. `
      + `checkout_worktree is user-authorized only: call it only after a direct human user explicitly requests or approves checkout. `
      + `Task completion, a merged PR, or inferred convenience is not permission to call it. When checkout would be a natural next step, `
      + `such as after a PR is merged, you may ask the user whether they want to check out the worktree; wait for their approval before calling.`
    )
  },
}
