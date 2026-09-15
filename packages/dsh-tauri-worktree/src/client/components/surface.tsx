import type { ReactElement } from 'react'
import type { SurfaceBarProps } from './surface.types'
import { CircleTree, Icon, useMountStyle } from 'dsh-tauri-ui/client'
import { useState } from 'react'
import { SURFACE_STYLE_ID } from '../constants'
import { useWorktreeSession } from '../hooks/use-worktree-session'
import { locale } from '../locales'
import { store } from '../store'
import surfaceStyle from './surface.cssr'

export function WorktreeSurface({ sessionId }: SurfaceBarProps): ReactElement | null {
  useMountStyle(surfaceStyle, SURFACE_STYLE_ID)
  locale.useLocale()
  const state = useWorktreeSession(sessionId)
  const [logOpen, setLogOpen] = useState(false)

  if (state.phase === 'idle' || state.mode === 'local')
    return null

  const creating = state.phase === 'creating'
  const deleting = state.phase === 'deleting'
  const failed = state.phase === 'error'
  const bound = state.mode === 'worktree'
  const label = creating
    ? state.loadingLabel || locale.text('progressCreating')
    : deleting
      ? locale.text('progressDeleting')
      : failed
        ? `${locale.text('progressError')}${state.error ? `: ${state.error}` : ''}`
        : locale.text('surfaceWorktree')

  return (
    <div className="dshp-worktree">
      <div className="dshp-worktree__surface">
        <div className="dshp-worktree__surface-bar" data-dsh-worktree-surface={sessionId}>
          <Icon as={CircleTree} size={14} />
          <div className="dshp-worktree__surface-content">
            <span className="dshp-worktree__surface-label">
              {label}
              {creating && `...`}
            </span>
            {bound && state.log.length > 0 && (
              <button type="button" className={`${'dshp-worktree__action'} ${'dshp-worktree__action--log'}`} onClick={() => setLogOpen(value => !value)}>
                {locale.text('progressViewLogs')}
              </button>
            )}
          </div>
          <span className="dshp-worktree__spacer" />
          {bound && !deleting && (
            <>
              <button type="button" className="dshp-worktree__action" onClick={() => store.worktree.patch(sessionId, { checkoutOpen: true })}>
                {locale.text('surfaceCheckout')}
              </button>
              <button type="button" className={`${'dshp-worktree__action'} ${'dshp-worktree__action--danger'}`} onClick={() => store.worktree.patch(sessionId, { abandonOpen: true })}>
                {locale.text('surfaceAbandon')}
              </button>
            </>
          )}
        </div>
        <Logs log={state.log} open={logOpen} />
      </div>
    </div>
  )
}

export function Logs({ log, open }: { log: readonly string[], open: boolean }): ReactElement {
  return (
    <div
      aria-hidden={!open}
      className={`${'dshp-worktree__logs'} ${open ? 'dshp-worktree__logs--open' : ''}`}
    >
      <div className="dshp-worktree__logs-inner">
        <div className="dshp-worktree__logs-panel">
          {log.map((line, index) => <div key={`${index}:${line}`} className="dshp-worktree__log-line">{line}</div>)}
        </div>
      </div>
    </div>
  )
}
