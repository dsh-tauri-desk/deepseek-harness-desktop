import type { HostContext } from './types'
import { clearHostRuntime, setCurrentHostInstance } from './config/runtime'
import { handleSessionEvent } from './events/session-event'
import { handleToolsExecute } from './events/tools-execute'
import { checkoutContextProvider } from './prompts/checkout-context'
import { worktreeSectionProvider } from './prompts/worktree-section'
import { routes } from './routes'
import { workspace } from './service/workspace'
import { checkoutWorktreeTool } from './tools/checkout-worktree'
import { createWorktreeTool } from './tools/create-worktree'

export function apply(ctx: HostContext): void {
  setCurrentHostInstance(ctx)

  ctx.tools.register(createWorktreeTool())
  ctx.tools.register(checkoutWorktreeTool())

  ctx.on('session/event', handleSessionEvent)
  ctx.on('tools/execute', handleToolsExecute)

  ctx.systemPrompt.section(worktreeSectionProvider)
  ctx.systemPrompt.context(checkoutContextProvider)

  ctx.effect(() => {
    void workspace.unregisterLegacy()
  }, 'plugin: unregister legacy worktree workspaces')

  ctx.effect(() => routes(ctx), 'plugin: routes')

  ctx.effect(() => () => clearHostRuntime(), 'plugin: host runtime')
}
