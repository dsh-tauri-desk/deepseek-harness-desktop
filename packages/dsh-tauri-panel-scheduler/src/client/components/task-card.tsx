import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { TaskView } from '../types'
import { Menu, Modal, Toast, IconWarningOutline16 as Warning } from '@deepseek-ai/dsh-client-ui-primitives'
import { CirclePause, CirclePlay, EllipsisVertical, Icon, TrashBin, useMountStyle } from 'dsh-tauri-ui/client'
import { useRef, useState } from 'react'
import { TASK_CARD_STYLE_ID } from '../constants'
import { deleteTask, runTask, toggleTask } from '../service/scheduler'
import taskCardStyle from './task-card.cssr'

export interface TaskCardProps {
  task: TaskView
  t: Translate
  describe: string
  nextRun?: string
  paused: boolean
  onEdit: (task: TaskView) => void
}

export function TaskCard({ task, t, describe, nextRun, paused, onEdit }: TaskCardProps): ReactElement {
  useMountStyle(taskCardStyle, TASK_CARD_STYLE_ID)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [toast, setToast] = useState<{ text: string, seq: number } | null>(null)
  const cardRef = useRef<HTMLLIElement | null>(null)

  async function runAction(
    action: () => Promise<{ ok: boolean, error?: string }>,
    errorKey: LocaleKey,
  ): Promise<void> {
    const result = await action()
    if (!result.ok) {
      const message = result.error ?? t(errorKey)
      setActionError(message)
      setToast({ text: message, seq: Date.now() })
      return
    }
    setActionError('')
    setToast(null)
  }

  async function onRun(): Promise<void> {
    try {
      await runAction(() => runTask(task.id), 'runFailed')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(error)
      setActionError(message)
      setToast({ text: message, seq: Date.now() })
    }
  }
  async function onToggle(): Promise<void> {
    await runAction(() => toggleTask(task.id, paused), 'toggleFailed')
  }
  async function onDelete(): Promise<void> {
    setConfirmOpen(false)
    const result = await deleteTask(task.id)
    if (!result.ok) {
      const message = result.error ?? t('deleteFailed')
      setActionError(message)
      setToast({ text: message, seq: Date.now() })
      return
    }
    setActionError('')
  }

  const items: MenuEntry[] = [
    { id: 'edit', label: t('edit'), icon: <Icon as={CirclePlay} /> },
    { id: 'run', label: t('runNow'), icon: <Icon as={CirclePlay} /> },
    { id: 'toggle', label: paused ? t('resume') : t('pause'), icon: <Icon as={CirclePause} /> },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('delete'), icon: <Icon as={TrashBin} />, danger: true },
  ]

  return (
    <li
      ref={cardRef}
      className={`${'dshp-scheduler__card'}${paused ? ` ${'dshp-scheduler__card--paused'}` : ''}`}
      onClick={(event) => {
        // 仅当点击落在卡片本体（title/meta 文本）时打开编辑；portaled 的菜单列表 /
        // Modal 不是 li 的 DOM 后代，contains() 为 false，不触发编辑（避免误开弹窗）。
        if (event.currentTarget.contains(event.target as Node))
          onEdit(task)
      }}
    >
      <div style={{ height: 36 }}>
        <span
          className="dshp-scheduler__task-toggle"
          aria-label={paused ? t('resume') : t('pause')}
          onClick={(event) => {
            event.stopPropagation()
            void onToggle()
          }}
        >
          {paused ? <Icon as={CirclePlay} /> : <Icon as={CirclePause} />}
        </span>
      </div>
      <div style={{ flex: 1 }}>
        <span className="dshp-scheduler__card-title" title={task.name}>
          {task.name}
        </span>
        <div className="dshp-scheduler__card-meta">
          <span className="dshp-scheduler__card-meta-text">
            {describe}
            {' · '}
            {nextRun !== undefined
              ? (
                  <>
                    <strong>
                      {t('nextRun')}
                      {' '}
                      {nextRun}
                    </strong>
                  </>
                )
              : <strong>{t('paused')}</strong>}
          </span>

        </div>
      </div>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'edit')
            onEdit(task)
          else if (id === 'run')
            onRun()
          else if (id === 'toggle')
            onToggle()
          else if (id === 'delete')
            setConfirmOpen(true)
        }}
        items={items}
        portal
        align="end"
        anchor={(
          <button
            type="button"
            className="dshp-scheduler__icon-button"
            aria-label={task.name}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen(openState => !openState)
            }}
          >
            <Icon as={EllipsisVertical} size={12} />
          </button>
        )}
      />
      {actionError ? <p className="dshp-scheduler__error" role="alert">{actionError}</p> : null}
      {toast !== null
        ? (
            <Toast
              key={toast.seq}
              text={toast.text}
              icon={<Icon as={Warning} />}
              anchor={cardRef.current}
              onDone={() => setToast(null)}
            />
          )
        : null}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`${t('deleteConfirmTitle')} ${task.name}？`}
        description={t('deleteConfirmBody')}
        closeLabel={t('close')}
        footer={(
          <>
            <button className="dshp-scheduler__btn" type="button" onClick={() => setConfirmOpen(false)}>{t('cancel')}</button>
            <button className={`${'dshp-scheduler__btn'} ${'dshp-scheduler__btn--danger'}`} type="button" onClick={() => void onDelete()}>{t('deleteConfirmAction')}</button>
          </>
        )}
      />
    </li>
  )
}
