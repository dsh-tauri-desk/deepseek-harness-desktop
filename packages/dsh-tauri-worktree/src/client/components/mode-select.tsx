import type { ReactElement } from 'react'
import type { ModeSelectProps } from '../types'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * mode-select.tsx — 「标准模式」右侧的会话工作模式选择器。
 *
 * 选择「新建工作树」只为下一条消息设为待创建；提交时先创建 worktree 和绑定该 cwd
 * 的新会话，再迁移草稿并调用官方 inputActions.submit()。
 *
 * 职责拆分：样式挂载在 styles.ts（mountModeSelectStyles），slot 注册在
 * register/mode-select.ts，等待输入服务的纯逻辑在 lib/worktree.ts。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  COMPOSER_MODE_BUTTON_SELECTOR,
  COMPOSER_PLAN_SLOT_SELECTOR,
  COMPOSER_SEAT_SELECTOR,
  HERO_PRESET_SLOT_SELECTOR,
  MODE_ANCHOR_ATTRIBUTE,
  MODE_SELECT_CLASSES,
} from '../constants'
import { text, useLocale } from '../locales'
import {
  attachWorktreeSession,
  createWorktree,
  patchSession,
  rememberNewSessionMode,
  useWorktreeSession,
} from '../store'
import { resolveAccessModeGroup, waitForInputActions, waitForSessionListed } from '../utils/worktree'
import { CircleTreeIcon } from './icons'

export function WorktreeModeSelect(props: ModeSelectProps): ReactElement {
  const { sessionId } = props
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [portalHost, setPortalHost] = useState<HTMLSpanElement | null>(null)

  useEffect(() => {
    const anchor = anchorRef.current
    // HARDCODE: DSH 0.1.1-rc.2 has no slot beside AgentPresetSeat, so this relies
    // on the shell's private composer marker and hero preset slot DOM placement.
    const composerSeat = anchor?.closest<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (!composerSeat)
      return

    let host: HTMLSpanElement | null = null
    const place = (): void => {
      // 访问模式按钮是官方「标准模式」右侧的稳定锚点（aria-label 由 input.accessMode
      // 提供，见 constants）。选择器始终优先插到其右侧的 .modes 分组（gap 16px），而不是
      // hero 的 Agent 预设槽位——后者只在 hero 首屏存在，会话开始后消失，会让控件「跳位」。
      const modeButton = composerSeat.querySelector<HTMLElement>(COMPOSER_MODE_BUTTON_SELECTOR)
      let target: HTMLElement | null = null
      if (modeButton) {
        const planSlot = composerSeat.querySelector<HTMLElement>(COMPOSER_PLAN_SLOT_SELECTOR)
        target = resolveAccessModeGroup(modeButton, planSlot)
      }
      // graceful fallback：composer 与模式按钮都缺失的极端布局下归位到 hero 预设槽位，
      // 保证控件不消失；此时锚点可能随 hero 卸载而消失，由 MutationObserver 重放。
      target ??= composerSeat.querySelector<HTMLElement>(HERO_PRESET_SLOT_SELECTOR)
      if (!target) {
        setPortalHost(null)
        host?.remove()
        host = null
        return
      }
      if (!host) {
        host = document.createElement('span')
        host.dataset.dshTauriWorktreeMode = sessionId
        host.className = MODE_SELECT_CLASSES.host
      }
      if (target.nextElementSibling !== host)
        target.after(host)
      setPortalHost(host)
    }

    place()
    const observer = new MutationObserver(place)
    observer.observe(composerSeat, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      host?.remove()
    }
  }, [sessionId])

  return (
    <>
      <span ref={anchorRef} className={MODE_SELECT_CLASSES.anchor} {...{ [MODE_ANCHOR_ATTRIBUTE]: sessionId }} />
      {portalHost && createPortal(<WorktreeModeControl {...props} />, portalHost)}
    </>
  )
}

function WorktreeModeControl({ sessionId, useInput, inputActions, sessionsRuntime, workspacesRuntime }: ModeSelectProps): ReactElement | null {
  const state = useWorktreeSession(sessionId)
  const draft = useInput(input => input.draft)
  const imageIds = useInput(input => input.imageIds)
  useLocale()
  const [open, setOpen] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    if (state.mode !== 'pending')
      return
    // HARDCODE: capture submission from the private composer DOM because the
    // current client API exposes inputActions.submit(), but no pre-submit hook.
    const root = document.querySelector<HTMLElement>(`[${MODE_ANCHOR_ATTRIBUTE}="${CSS.escape(sessionId)}"]`)
    const composerSeat = root?.closest<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (!composerSeat)
      return

    const start = async (): Promise<void> => {
      if (submittingRef.current || draft.trim() === '')
        return
      submittingRef.current = true
      const targetSessionId = `session-${crypto.randomUUID()}`
      patchSession(sessionId, { mode: 'pending', phase: 'creating', loadingLabel: text('progressCreating'), error: '' })
      try {
        // inherit=true：由宿主用源会话完整事件建好「已是完整会话」的工作树会话
        // （问题 2 修复）。宿主返回 inherited=false 时才回退官方空白会话路径。
        const created = await createWorktree(targetSessionId, sessionId, true)
        patchSession(targetSessionId, {
          mode: 'worktree',
          phase: 'created',
          loadingLabel: text('progressCreated'),
          log: created.log,
          worktreeKey: created.worktreeKey,
          worktreePath: created.worktreePath,
          projectPath: created.projectPath,
          sourceSessionId: created.sourceSessionId,
        })
        if (created.inherited) {
          // 宿主 seed 建的会话需先进入客户端会话列表才能寻址，等待而非 create（防「已存在会话」）。
          await waitForSessionListed(sessionsRuntime, targetSessionId)
        }
        else {
          await sessionsRuntime.create({ cwd: created.worktreePath, sessionId: targetSessionId })
        }
        await attachWorktreeSession(targetSessionId)
        const nextActions = await waitForInputActions(sessionsRuntime, targetSessionId)
        nextActions.setDraft(draft)
        if (imageIds.length > 0 && !nextActions.addImages(imageIds))
          throw new Error('无法迁移消息附件到工作树会话')
        inputActions.setDraft('')
        for (const imageId of imageIds) inputActions.removeImage(imageId)
        patchSession(sessionId, { mode: 'local', phase: 'idle', loadingLabel: '' })
        sessionsRuntime.open(targetSessionId)
        // 迁移草稿后提交到新工作树会话；submit() 会在进入时同步捕获草稿/附件快照再发送。
        // 无论提交结果如何，创建了工作树就必须清空输入框内容（含附件），避免内容仍残留进后续新会话。
        queueMicrotask(() => {
          try {
            nextActions.submit()
          }
          finally {
            nextActions.setDraft('')
            for (const imageId of imageIds) nextActions.removeImage(imageId)
          }
        })
        // 源会话完整对话已继承进工作树会话：归档源会话，避免侧边栏多出一个重复会话。
        // 仅 inherited 成功时归档——空白回退路径（inherited=false）下源会话仍保有原始
        // 对话，删除会造成会话信息丢失。先 open(target) 再 archive(source)：archiveSession
        // 的投影只在被归档会话是当前会话时清空选择，此刻 current 已是目标会话，选择不受影响。
        if (created.inherited)
          await workspacesRuntime.archiveSession(sessionId).catch(() => {})
      }
      catch (error) {
        patchSession(sessionId, {
          mode: 'pending',
          phase: 'error',
          loadingLabel: '',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      finally {
        submittingRef.current = false
      }
    }

    const intercept = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node) || !composerSeat.contains(target))
        return
      if (event instanceof MouseEvent) {
        const button = target instanceof Element ? target.closest('button[aria-label]') : null
        if (button?.getAttribute('aria-label')?.includes('发送') !== true && button?.getAttribute('aria-label')?.toLowerCase().includes('send') !== true)
          return
      }
      if (event instanceof KeyboardEvent && (event.key !== 'Enter' || event.shiftKey || event.isComposing))
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      void start()
    }

    composerSeat.addEventListener('click', intercept, true)
    composerSeat.addEventListener('keydown', intercept, true)
    return () => {
      composerSeat.removeEventListener('click', intercept, true)
      composerSeat.removeEventListener('keydown', intercept, true)
    }
  }, [draft, imageIds, inputActions, sessionId, sessionsRuntime, state.mode, workspacesRuntime])

  // 已是工作树会话：完整对话已迁移进隔离工作树，模式选择不再有意义，整个控件隐藏。
  // 状态由常驻 surface 提示条（检出本地 / 放弃）接管；重新选回本地走官方检出流程。
  if (state.mode === 'worktree')
    return null
  // 非 git 目录不提供工作树：隐藏整个模式选择器，会话永远只能停留在本地模式。
  if (state.isGit === false)
    return null

  const pending = state.mode === 'pending'
  const activeLabel = pending ? text('modeNewWorktree') : text('modeLocal')
  const trigger = (
    <button
      type="button"
      aria-label={text('modeLabel')}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
      className={open ? `${MODE_SELECT_CLASSES.trigger} ${MODE_SELECT_CLASSES.triggerOpen}` : MODE_SELECT_CLASSES.trigger}
    >
      <span className={MODE_SELECT_CLASSES.icon}>
        <CircleTreeIcon size={13} />
      </span>
      <span>{activeLabel}</span>
      <IconChevronDownOutline14 className={MODE_SELECT_CLASSES.chevron} />
    </button>
  )

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={[
        { id: 'local', label: text('modeLocal') },
        { id: 'pending', label: text('modeWorktree') },
      ]}
      selectedId={pending ? 'pending' : 'local'}
      onSelect={(id) => {
        setOpen(false)
        const mode = id === 'pending' ? 'pending' : 'local'
        rememberNewSessionMode(mode)
        patchSession(sessionId, {
          mode,
          phase: 'idle',
          loadingLabel: '',
          error: '',
        })
      }}
      side="bottom"
      align="start"
      portal
      anchor={trigger}
    />
  )
}
