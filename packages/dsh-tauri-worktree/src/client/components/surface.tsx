import type { ReactElement } from 'react'
import type { SurfaceBarProps } from '../types'
/**
 * surface.tsx — 聊天框正上方、仅会话内容区内的工作树状态条。
 *
 * 职责拆分：slot 注册在 register/surface.ts，样式在 styles.ts。
 */
import { useState } from 'react'
import { text, useLocale } from '../locales'
import { patchSession, useWorktreeSession } from '../store'
import { worktreeStyles } from '../styles'
import { CircleTreeIcon } from './icons'

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
