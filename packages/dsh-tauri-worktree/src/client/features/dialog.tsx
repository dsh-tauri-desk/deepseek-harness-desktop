import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import type { WorkspacesRuntime, WorktreeDialogProps } from '../types'
import { compat } from 'dsh-tauri/client'
/**
 * dialog.tsx — 检出本地 / 放弃更改 两个模态框（shell.overlay 条目）。
 *
 * 需求：
 *   - 检出本地：标题「将更改带回本地检出并继续」；分支名输入框预填 `dsh/`；
 *     显示「当前关联路径 [hash]/[dirname]」与「目标项目路径 [项目路径]」；
 *     按钮「确认检出并合并 / 取消」。
 *   - 放弃更改：标题「放弃工作树更改」；确认文本「确认放弃吗？这将删除当前会话及
 *     对应的临时工作树。」；按钮「确认放弃（危险）/ 取消」。
 *
 * 两个弹窗由 store 的 checkoutOpen / abandonOpen 驱动；均渲染为 shell.overlay
 * 下的居中模态（层本身 click-through，条目 opt-in pointer events）。
 */
import { useEffect } from 'react'
import { DIALOG_EFFECT, DIALOG_ID, SHELL_OVERLAY_SLOT, WORKTREE_PLUGIN_NAME } from '../constants'
import { text, useLocale } from '../locale'
import { resolveWorkspaceTopInsertion } from '../session'
import { applyCheckout, applyDiscard, patchSession, useWorktreeSession } from '../store'
import { worktreeStyles } from '../styles'

/**
 * 检出本地 / 放弃 弹窗组件（读 store 的 checkoutOpen / abandonOpen 决定渲染哪个）。
 * @param props - 复合槽位 props。
 * @param props.useSessions - 标准钩子：会话列表快照（取当前会话 id）。
 * @param props.workspacesRuntime - 宿主工作区运行时（归档会话）。
 * @param props.sessionsRuntime - 宿主会话运行时（打开继承会话）。
 * @returns 居中模态（无打开项时返回 null）。
 */
export function WorktreeDialog({ useSessions, workspacesRuntime, sessionsRuntime }: WorktreeDialogProps): ReactElement | null {
  useLocale()
  const sessionId = useSessions(state => state.current)
  const state = useWorktreeSession(sessionId)
  const checkout = state.checkoutOpen
  const abandon = state.abandonOpen
  const closeAll = (): void => patchSession(sessionId, { checkoutOpen: false, abandonOpen: false })

  // Hook 必须在所有 render 中保持相同顺序；仅打开弹窗时安装 Esc 监听。
  useEffect(() => {
    if (!sessionId || (!checkout && !abandon))
      return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape')
        closeAll()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sessionId, checkout, abandon])

  if (!sessionId || (!checkout && !abandon))
    return null

  return (
    <div className={worktreeStyles.modal} data-dsh-worktree-dialog="1" onClick={closeAll}>
      {checkout && (
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
      {abandon && (
        <AbandonDialog
          sessionId={sessionId}
          worktreeKey={state.worktreeKey}
          error={state.error}
          workspacesRuntime={workspacesRuntime}
          onCancel={closeAll}
        />
      )}
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
  const branchName = props.branchName || 'dsh/'
  const disabled = branchName.trim() === '' || branchName.trim().endsWith('/')

  const updateBranch = (value: string): void => patchSession(sessionId, { branchName: value })
  const waitUntilListed = async (targetSessionId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await sessionsRuntime.refresh()
        if (sessionsRuntime.list.getSnapshot().ids.includes(targetSessionId))
          return true
      }
      catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  }
  const openAndConfirm = async (targetSessionId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        sessionsRuntime.open(targetSessionId)
        if (sessionsRuntime.list.getSnapshot().current === targetSessionId)
          return true
      }
      catch {
        await sessionsRuntime.refresh().catch(() => {})
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  }
  const promoteToWorkspaceTop = async (targetSessionId: string): Promise<void> => {
    const insertion = resolveWorkspaceTopInsertion(
      workspacesRuntime.list.getSnapshot().items,
      projectPath,
      targetSessionId,
    )
    if (!insertion)
      return
    await workspacesRuntime.insertSessionBefore(
      insertion.workspaceId,
      targetSessionId,
      insertion.beforeSessionId,
    )
  }
  const checkout = async (): Promise<void> => {
    const result = await applyCheckout(sessionId, worktreeKey, branchName.trim())
    if (!result.ok)
      return
    if (!result.targetSessionId) {
      patchSession(sessionId, { checkoutOpen: false })
      return
    }
    const listed = await waitUntilListed(result.targetSessionId)
    if (!listed) {
      patchSession(sessionId, { error: `Local session ${result.targetSessionId} was created but did not appear in the session list.` })
      return
    }
    await promoteToWorkspaceTop(result.targetSessionId).catch(() => {})
    await workspacesRuntime.archiveSession(sessionId)
    const opened = await openAndConfirm(result.targetSessionId)
    if (!opened)
      patchSession(sessionId, { error: `Local session ${result.targetSessionId} could not be selected.` })
  }

  return (
    <div
      className={worktreeStyles.card}
      role="dialog"
      aria-modal="true"
      aria-label={text('checkoutTitle')}
      onClick={event => event.stopPropagation()}
    >
      <h2 className={worktreeStyles.title}>{text('checkoutTitle')}</h2>
      <div className={worktreeStyles.field}>
        <label className={worktreeStyles.fieldLabel} htmlFor="wt-checkout-branch">{text('checkoutBranchLabel')}</label>
        <div className={worktreeStyles.inputWrap}>
          <input
            id="wt-checkout-branch"
            className={worktreeStyles.input}
            value={branchName}
            placeholder="dsh/feature-xyz"
            onChange={event => updateBranch(event.target.value)}
          />
        </div>
      </div>
      <div className={worktreeStyles.pathRow}>
        <span className={worktreeStyles.pathKey}>{text('checkoutCurrentPath')}</span>
        <span className={worktreeStyles.pathValue}>{worktreeKey || '—'}</span>
      </div>
      <div className={worktreeStyles.pathRow}>
        <span className={worktreeStyles.pathKey}>{text('checkoutTargetPath')}</span>
        <span className={worktreeStyles.pathValue}>{projectPath.replaceAll('\\', '/') || '—'}</span>
      </div>
      {props.error && <div className={worktreeStyles.error}>{props.error}</div>}
      <div className={worktreeStyles.footer}>
        <button type="button" className={`${worktreeStyles.button} ${worktreeStyles.buttonGhost}`} onClick={onCancel}>{text('checkoutCancel')}</button>
        <button
          type="button"
          className={`${worktreeStyles.button} ${worktreeStyles.buttonPrimary} ${disabled ? worktreeStyles.buttonDisabled : ''}`}
          disabled={disabled}
          onClick={() => void checkout()}
        >
          {text('checkoutConfirm')}
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
  onCancel: () => void
}): ReactElement {
  const { sessionId, worktreeKey, workspacesRuntime, onCancel } = props
  const abandon = async (): Promise<void> => {
    const result = await applyDiscard(sessionId, worktreeKey)
    if (!result.ok)
      return
    // 不显式打开源会话：官方 archiveSession 投影会清空当前选择，回到
    // 「选择一个工作区开始」默认界面；显式 open 会触发工作区新建/复用 blank 会话。
    await workspacesRuntime.archiveSession(sessionId)
  }
  return (
    <div
      className={worktreeStyles.card}
      role="dialog"
      aria-modal="true"
      aria-label={text('abandonTitle')}
      onClick={event => event.stopPropagation()}
    >
      <h2 className={worktreeStyles.title}>{text('abandonTitle')}</h2>
      <p className={worktreeStyles.body}>{text('abandonBody')}</p>
      {props.error && <div className={worktreeStyles.error}>{props.error}</div>}
      <div className={worktreeStyles.footer}>
        <button type="button" className={`${worktreeStyles.button} ${worktreeStyles.buttonGhost}`} onClick={onCancel}>{text('abandonCancel')}</button>
        <button
          type="button"
          className={`${worktreeStyles.button} ${worktreeStyles.buttonDanger}`}
          onClick={() => void abandon()}
        >
          {text('abandonConfirm')}
        </button>
      </div>
    </div>
  )
}

/**
 * 注册：shell.overlay（list）新增一个条目，渲染检出/放弃弹窗。
 * @param ctx - 客户端根上下文。
 */
export function registerDialog(ctx: Context): void {
  const cx = compat(ctx as import('dsh-tauri/client').ClientContext)
  // shell.overlay 由 ui-layout 的 AppFrame 声明；alpha 要求注册进入前该槽已由
  // 父条目 children 表声明，故用 inject 等其声明 live 后再注册。
  ctx.effect(
    () =>
      ctx.slots.inject(SHELL_OVERLAY_SLOT, () =>
        ctx.slots.register(
          {
            name: SHELL_OVERLAY_SLOT,
            id: DIALOG_ID,
            registrant: WORKTREE_PLUGIN_NAME,
            inject: () => ({
              workspacesRuntime: cx.workspaces,
              sessionsRuntime: cx.sessions,
            }),
          },
          WorktreeDialog,
        )),
    DIALOG_EFFECT,
  )
}
