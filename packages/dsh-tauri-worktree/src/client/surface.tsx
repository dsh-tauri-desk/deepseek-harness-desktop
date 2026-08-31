import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { SurfaceBarProps } from './types'
/**
 * surface.tsx — 聊天框正上方、仅会话内容区内的工作树状态条。
 */
import { useState } from 'react'
import { INPUT_DOCK_SLOT, SURFACE_ID, SURFACE_ORDER } from './constants'
import { CircleTreeIcon } from './icons'
import { text, useLocale } from './locale'
import { patchSession, useWorktreeSession } from './store'
import { worktreeStyles } from './styles'

export function WorktreeSurface({ sessionId }: SurfaceBarProps): ReactElement | null {
  useLocale()
  const state = useWorktreeSession(sessionId)
  const [logOpen, setLogOpen] = useState(false)

  if (state.phase === 'idle' || state.mode === 'local')
    return null

  const creating = state.phase === 'creating'
  const failed = state.phase === 'error'
  const bound = state.mode === 'worktree'
  const label = creating
    ? state.loadingLabel || text('progressCreating')
    : failed
      ? `${text('progressError')}${state.error ? `: ${state.error}` : ''}`
      : text('surfaceWorktree')

  return (
    <div className={worktreeStyles.surface}>
      <div className={worktreeStyles.surfaceBar} data-dsh-worktree-surface={sessionId}>
        <CircleTreeIcon size={14} />
        <div className={worktreeStyles.surfaceContent}>
          <span className={worktreeStyles.surfaceLabel}>
            {label}
            {creating && `...`}
          </span>
          {bound && state.log.length > 0 && (
            <button type="button" className={`${worktreeStyles.action} ${worktreeStyles.actionLog}`} onClick={() => setLogOpen(value => !value)}>
              {text('progressViewLogs')}
            </button>
          )}
        </div>
        <span className={worktreeStyles.spacer} />
        {bound && (
          <>
            <button type="button" className={worktreeStyles.action} onClick={() => patchSession(sessionId, { checkoutOpen: true })}>
              {text('surfaceCheckout')}
            </button>
            <button type="button" className={`${worktreeStyles.action} ${worktreeStyles.actionDanger}`} onClick={() => patchSession(sessionId, { abandonOpen: true })}>
              {text('surfaceAbandon')}
            </button>
          </>
        )}
      </div>
      <Logs log={state.log} open={logOpen} />
    </div>
  )
}

export function Logs({ log, open }: { log: string[], open: boolean }): ReactElement {
  return (
    <div
      aria-hidden={!open}
      className={`${worktreeStyles.logs} ${open ? worktreeStyles.logsOpen : ''}`}
    >
      <div className={worktreeStyles.logsInner}>
        <div className={worktreeStyles.logsPanel}>
          {log.map((line, index) => <div key={`${index}:${line}`} className={worktreeStyles.logLine}>{line}</div>)}
        </div>
      </div>
    </div>
  )
}

/** input.dock 正位于 inputBar 上方，宽度天然受右侧会话内容区约束。 */
export function registerSurface(ctx: Context): void {
  ctx.slots.inject(INPUT_DOCK_SLOT as never, () =>
    ctx.slots.register(
      {
        name: INPUT_DOCK_SLOT,
        id: SURFACE_ID,
        order: SURFACE_ORDER,
        inject: (sessionId: string | undefined) => sessionId === undefined ? undefined : { sessionId },
      } as never,
      WorktreeSurface,
    ))
}
