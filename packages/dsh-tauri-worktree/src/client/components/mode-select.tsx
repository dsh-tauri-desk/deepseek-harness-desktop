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
import { waitForInputActions } from '../utils/worktree'
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
      // rc.2 exposes the hero preset slot; alpha removed it but keeps the
      // stable composer mode button. Prefer the old anchor and fall back to
      // the button without depending on generated CSS module hashes.
      const presetSlot = composerSeat.querySelector<HTMLElement>(HERO_PRESET_SLOT_SELECTOR)
      const modeButton = composerSeat.querySelector<HTMLElement>(COMPOSER_MODE_BUTTON_SELECTOR)
      const target = presetSlot ?? modeButton
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

function WorktreeModeControl({ sessionId, useInput, inputActions, sessionsRuntime }: ModeSelectProps): ReactElement | null {
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
        const created = await createWorktree(targetSessionId, sessionId)
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
        await sessionsRuntime.create({ cwd: created.worktreePath, sessionId: targetSessionId })
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
  }, [draft, imageIds, inputActions, sessionId, sessionsRuntime, state.mode])

  // 非 git 目录不提供工作树：隐藏整个模式选择器，会话永远只能停留在本地模式。
  if (state.isGit === false)
    return null

  const pending = state.mode === 'pending'
  const bound = state.mode === 'worktree'
  const activeLabel = bound ? text('modeWorktree') : pending ? text('modeNewWorktree') : text('modeLocal')
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
      items={bound
        ? [{ id: 'worktree', label: text('modeWorktree') }]
        : [
            { id: 'local', label: text('modeLocal') },
            { id: 'pending', label: text('modeWorktree') },
          ]}
      selectedId={bound ? 'worktree' : pending ? 'pending' : 'local'}
      onSelect={(id) => {
        setOpen(false)
        if (bound)
          return
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
