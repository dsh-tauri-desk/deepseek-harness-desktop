import type { ReactElement } from 'react'
import type { WorkspacesRuntime } from '../service/session-switch.types'
import type { WorktreeDialogProps } from './dialog.types'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { find, useEventListener } from 'dsh-tauri/client'
import { useRef } from 'react'
import { DIALOG_STYLE_ID } from '../constants'
import { useDiscard } from '../hooks/use-discard'
import { useWaiter } from '../hooks/use-waiter'
import { useWorktreeSession } from '../hooks/use-worktree-session'
import { locale } from '../locales'
import { openSession, waitForSessionListed } from '../service/session-switch'
import { checkout } from '../service/worktree'
import { store } from '../store'
import dialogStyle from './dialog.cssr'

export function WorktreeDialog({ useSessions, workspacesRuntime, sessionsRuntime }: WorktreeDialogProps): ReactElement | null {
  locale.useLocale()
  useMountStyle(dialogStyle, DIALOG_STYLE_ID)
  const sessionId = useSessions(state => state.current)
  const state = useWorktreeSession(sessionId)
  const discardWorktree = useDiscard(sessionId)
  const checkoutOpen = state.checkoutOpen
  const abandonOpen = state.abandonOpen
  const closeAll = (): void => store.worktree.patch(sessionId, { checkoutOpen: false, abandonOpen: false })

  const documentRef = useRef<Document | null | undefined>(
    typeof document === 'undefined' ? undefined : document,
  )
  useEventListener(documentRef, 'keydown', (event: KeyboardEvent) => {
    if ((checkoutOpen || abandonOpen) && event.key === 'Escape')
      closeAll()
  })

  if (!sessionId || (!checkoutOpen && !abandonOpen))
    return null

  return (
    <div className="dshp-worktree">
      <div className="dshp-worktree__modal" data-dsh-worktree-dialog="1" onClick={closeAll}>
        {checkoutOpen && (
          <CheckoutDialog
            sessionId={sessionId}
            worktreeKey={state.worktreeKey}
            projectPath={state.projectPath}
            branchName={state.branchName}
            error={state.error}
            workspacesRuntime={workspacesRuntime}
            sessionsRuntime={sessionsRuntime}
            onCancel={closeAll}
          />
        )}
        {abandonOpen && (
          <AbandonDialog
            sessionId={sessionId}
            worktreeKey={state.worktreeKey}
            error={state.error}
            workspacesRuntime={workspacesRuntime}
            discardWorktree={discardWorktree}
            onCancel={closeAll}
          />
        )}
      </div>
    </div>
  )
}

function CheckoutDialog(props: {
  sessionId: string
  worktreeKey: string
  projectPath: string
  branchName: string
  error: string
  workspacesRuntime: WorkspacesRuntime
  sessionsRuntime: {
    open: (sessionId: string) => void
    refresh: () => Promise<void>
    list: { getSnapshot: () => { current?: string, ids: string[] } }
  }
  onCancel: () => void
}): ReactElement {
  const { sessionId, worktreeKey, projectPath, workspacesRuntime, sessionsRuntime, onCancel } = props
  const { wait } = useWaiter()
  const branchName = props.branchName || 'dsh/'
  const disabled = branchName.trim() === '' || branchName.trim().endsWith('/')

  const updateBranch = (value: string): void => store.worktree.patch(sessionId, { branchName: value })

  const promoteToWorkspaceTop = async (targetSessionId: string): Promise<void> => {
    const workspace = find(workspacesRuntime.list.getSnapshot().items, item => item.path === projectPath)
    if (!workspace)
      return
    await workspacesRuntime.insertSessionBefore(
      workspace.workspaceId,
      targetSessionId,
      find(workspace.sessionIds, id => id !== targetSessionId),
    )
  }

  const confirm = async (): Promise<void> => {
    const result = await checkout({ sessionId, worktreeKey, branchName: branchName.trim() })
    if (!result.ok || !result.targetSessionId)
      return
    const targetSessionId = result.targetSessionId
    try {
      await waitForSessionListed({ sessions: sessionsRuntime, sessionId: targetSessionId, wait, attempts: 30, delayMs: 250 })
    }
    catch {
      store.worktree.patch(sessionId, { error: `Local session ${targetSessionId} was created but did not appear in the session list.` })
      return
    }
    await promoteToWorkspaceTop(targetSessionId).catch(() => {})
    await workspacesRuntime.archiveSession(sessionId).catch(() => {})
    const opened = await openSession({ sessions: sessionsRuntime, sessionId: targetSessionId, wait, attempts: 10, delayMs: 100 })
    if (!opened)
      store.worktree.patch(sessionId, { error: `Local session ${targetSessionId} could not be selected.` })
  }

  return (
    <div
      className="dshp-worktree__dialog-card"
      role="dialog"
      aria-modal="true"
      aria-label={locale.text('checkoutTitle')}
      onClick={event => event.stopPropagation()}
    >
      <h2 className="dshp-worktree__dialog-title">{locale.text('checkoutTitle')}</h2>
      <div className="dshp-worktree__dialog-field">
        <label className="dshp-worktree__dialog-field-label" htmlFor="wt-checkout-branch">{locale.text('checkoutBranchLabel')}</label>
        <div className="dshp-worktree__dialog-input-wrap">
          <input
            id="wt-checkout-branch"
            className="dshp-worktree__dialog-input"
            value={branchName}
            placeholder={locale.text('branchPlaceholder')}
            onChange={event => updateBranch(event.target.value)}
          />
        </div>
      </div>
      <div className="dshp-worktree__dialog-path-row">
        <span className="dshp-worktree__dialog-path-key">{locale.text('checkoutCurrentPath')}</span>
        <span className="dshp-worktree__dialog-path-value">{worktreeKey || '—'}</span>
      </div>
      <div className="dshp-worktree__dialog-path-row">
        <span className="dshp-worktree__dialog-path-key">{locale.text('checkoutTargetPath')}</span>
        <span className="dshp-worktree__dialog-path-value">{projectPath.replaceAll('\\', '/') || '—'}</span>
      </div>
      {props.error && <div className="dshp-worktree__dialog-error">{props.error}</div>}
      <div className="dshp-worktree__dialog-footer">
        <button type="button" className={`${'dshp-worktree__dialog-button'} ${'dshp-worktree__dialog-button--ghost'}`} onClick={onCancel}>{locale.text('checkoutCancel')}</button>
        <button
          type="button"
          className={`${'dshp-worktree__dialog-button'} ${'dshp-worktree__dialog-button--primary'} ${disabled ? 'dshp-worktree__dialog-button--disabled' : ''}`}
          disabled={disabled}
          onClick={() => void confirm()}
        >
          {locale.text('checkoutConfirm')}
        </button>
      </div>
    </div>
  )
}

function AbandonDialog(props: {
  sessionId: string
  worktreeKey: string
  error: string
  workspacesRuntime: Pick<WorkspacesRuntime, 'archiveSession'>
  discardWorktree: (input: { worktreeKey: string }) => Promise<{ ok: boolean, error?: string }>
  onCancel: () => void
}): ReactElement {
  const { sessionId, worktreeKey, workspacesRuntime, discardWorktree, onCancel } = props
  const abandon = async (): Promise<void> => {
    const result = await discardWorktree({ worktreeKey })
    if (!result.ok)
      return
    await workspacesRuntime.archiveSession(sessionId)
  }
  return (
    <div
      className="dshp-worktree__dialog-card"
      role="dialog"
      aria-modal="true"
      aria-label={locale.text('abandonTitle')}
      onClick={event => event.stopPropagation()}
    >
      <h2 className="dshp-worktree__dialog-title">{locale.text('abandonTitle')}</h2>
      <p className="dshp-worktree__dialog-body">{locale.text('abandonBody')}</p>
      {props.error && <div className="dshp-worktree__dialog-error">{props.error}</div>}
      <div className="dshp-worktree__dialog-footer">
        <button type="button" className={`${'dshp-worktree__dialog-button'} ${'dshp-worktree__dialog-button--ghost'}`} onClick={onCancel}>{locale.text('abandonCancel')}</button>
        <button
          type="button"
          className={`${'dshp-worktree__dialog-button'} ${'dshp-worktree__dialog-button--danger'}`}
          onClick={() => void abandon()}
        >
          {locale.text('abandonConfirm')}
        </button>
      </div>
    </div>
  )
}
