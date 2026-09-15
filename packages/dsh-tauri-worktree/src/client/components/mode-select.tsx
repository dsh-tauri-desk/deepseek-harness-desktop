import type { ReactElement } from 'react'
import type { ModeSelectProps } from './mode-select.types'
import { IconChevronDownOutline14 as ChevronDown, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { CircleTree, Icon } from 'dsh-tauri-ui/client'
import { forEach, get } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  COMPOSER_MODE_BUTTON_SELECTOR,
  COMPOSER_PLAN_SLOT_SELECTOR,
  COMPOSER_SEAT_SELECTOR,
  HERO_PRESET_SLOT_SELECTOR,
  MODE_ANCHOR_ATTRIBUTE,
} from '../constants'
import { useWaiter } from '../hooks/use-waiter'
import { useWorktreeSession } from '../hooks/use-worktree-session'
import { locale } from '../locales'
import { rememberPreferredMode } from '../service/preferences'
import { waitForInputActions, waitForSessionListed } from '../service/session-switch'
import { attach, create } from '../service/worktree'
import { store } from '../store'
import { addDraftAttachments, draftAttachmentIds, removeDraftAttachment, resolveAccessModeGroup } from './mode-select.utils'

export function WorktreeModeSelect(props: ModeSelectProps): ReactElement {
  const { sessionId } = props
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [portalHost, setPortalHost] = useState<HTMLSpanElement | null>(null)

  // keep:effect composer 锚点由组件 ref 决定，DOM 重排观察无法上提到 register
  useEffect(() => {
    const anchor = anchorRef.current
    const composerSeat = anchor?.closest<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (!composerSeat)
      return

    let host: HTMLSpanElement | null = null
    const place = (): void => {
      const modeButton = composerSeat.querySelector<HTMLElement>(COMPOSER_MODE_BUTTON_SELECTOR)
      let target: HTMLElement | null = null
      if (modeButton) {
        const planSlot = composerSeat.querySelector<HTMLElement>(COMPOSER_PLAN_SLOT_SELECTOR)
        target = resolveAccessModeGroup(modeButton, planSlot)
      }
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
        host.className = 'dshp-mode-select__host'
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
      <span ref={anchorRef} className="dshp-mode-select__anchor" {...{ [MODE_ANCHOR_ATTRIBUTE]: sessionId }} />
      {portalHost && createPortal(<WorktreeModeControl {...props} />, portalHost)}
    </>
  )
}

function WorktreeModeControl({ sessionId, useInput, inputActions, sessionsRuntime, workspacesRuntime }: ModeSelectProps): ReactElement | null {
  const state = useWorktreeSession(sessionId)
  const draft = useInput(input => input.draft)
  const imageIds = useInput(draftAttachmentIds)
  const { wait } = useWaiter()
  locale.useLocale()
  const [open, setOpen] = useState(false)
  const submittingRef = useRef(false)

  // keep:effect 发送拦截依赖官方 composer 私有 DOM，没有 pre-submit 钩子可用
  useEffect(() => {
    if (state.mode !== 'pending')
      return
    const root = document.querySelector<HTMLElement>(`[${MODE_ANCHOR_ATTRIBUTE}="${CSS.escape(sessionId)}"]`)
    const composerSeat = root?.closest<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (!composerSeat)
      return

    const start = async (): Promise<void> => {
      if (submittingRef.current || draft.trim() === '')
        return
      submittingRef.current = true
      const targetSessionId = `session-${crypto.randomUUID()}`
      store.worktree.patch(sessionId, { mode: 'pending', phase: 'creating', loadingLabel: locale.text('progressCreating'), error: '' })
      try {
        const created = await create({ sessionId: targetSessionId, sourceSessionId: sessionId, inherit: true })
        if (!created.ok || !created.result)
          throw new Error(created.error ?? 'Failed to create worktree.')
        const result = created.result
        if (result.inherited) {
          await waitForSessionListed({ sessions: sessionsRuntime, sessionId: targetSessionId, wait })
        }
        else {
          await sessionsRuntime.create({ cwd: result.worktreePath, sessionId: targetSessionId })
        }
        await attach({ sessionId: targetSessionId })
        const nextActions = await waitForInputActions({ sessions: sessionsRuntime, sessionId: targetSessionId, wait })
        nextActions.setDraft(draft)
        if (!addDraftAttachments(nextActions, imageIds))
          throw new Error('无法迁移消息附件到工作树会话')
        inputActions.setDraft('')
        forEach(imageIds, imageId => removeDraftAttachment(inputActions, imageId))
        store.worktree.patch(sessionId, { mode: 'local', phase: 'idle', loadingLabel: '' })
        sessionsRuntime.open(targetSessionId)
        queueMicrotask(() => {
          try {
            nextActions.submit()
          }
          finally {
            nextActions.setDraft('')
            forEach(imageIds, imageId => removeDraftAttachment(nextActions, imageId))
          }
        })
        if (result.inherited)
          await workspacesRuntime.archiveSession(sessionId).catch(() => {})
      }
      catch (error) {
        store.worktree.patch(sessionId, {
          mode: 'pending',
          phase: 'error',
          loadingLabel: '',
          error: get(error, 'message', String(error)),
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
  }, [draft, imageIds, inputActions, sessionId, sessionsRuntime, state.mode, wait, workspacesRuntime])

  if (state.mode === 'worktree')
    return null
  if (state.isGit === false)
    return null

  const pending = state.mode === 'pending'
  const activeLabel = pending ? locale.text('modeNewWorktree') : locale.text('modeLocal')
  const trigger = (
    <button
      type="button"
      aria-label={locale.text('modeLabel')}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
      className={open ? `${'dshp-mode-select__trigger'} ${'dshp-mode-select__trigger--open'}` : 'dshp-mode-select__trigger'}
    >
      <span className="dshp-mode-select__icon">
        <Icon as={CircleTree} size={13} />
      </span>
      <span className="dshp-mode-select__label">{activeLabel}</span>
      <Icon as={ChevronDown} className="dshp-mode-select__chevron" />
    </button>
  )

  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={[
        { id: 'local', label: locale.text('modeLocal') },
        { id: 'pending', label: locale.text('modeWorktree') },
      ]}
      selectedId={pending ? 'pending' : 'local'}
      onSelect={(id) => {
        setOpen(false)
        const mode = id === 'pending' ? 'pending' : 'local'
        void rememberPreferredMode({ mode })
        store.worktree.patch(sessionId, {
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
