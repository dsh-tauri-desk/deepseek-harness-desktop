/**
 * components/task-card.tsx — 任务列表卡片：名称 + 计划·下次运行 + [...] 菜单。
 *
 * [...] 菜单用官方 primitives `Menu`（portal，align=end），条目：立即运行 /
 * 暂停或恢复 / 删除（danger）。删除经官方 `Modal` 二次确认（与 dsh-tauri-session
 * 的归档删除一致）。
 */

import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import type { TaskView, Translate } from '../types'
import { IconWarningOutline16, Menu, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRef, useState } from 'react'
import { SCHEDULER_CLASSES as K } from '../constants'
import { applyDeleteTask, applyRunTask, applyToggleTask } from '../store'
import { IconMore, IconPause, IconPlay, IconTrash } from './icons'

export interface TaskCardProps {
  task: TaskView
  t: Translate
  describe: string
  nextRun?: string
  paused: boolean
  /** 点击卡片主体 → 打开编辑弹窗（复用创建弹窗）。 */
  onEdit: (task: TaskView) => void
}

export function TaskCard({ task, t, describe, nextRun, paused, onEdit }: TaskCardProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [toast, setToast] = useState<{ text: string, seq: number } | null>(null)
  const cardRef = useRef<HTMLLIElement | null>(null)

  async function runAction(
    action: () => Promise<{ ok: boolean, error?: string }>,
    errorKey: 'runFailed' | 'toggleFailed' | 'deleteFailed',
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
      await runAction(() => applyRunTask(task.id), 'runFailed')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(error)
      setActionError(message)
      setToast({ text: message, seq: Date.now() })
    }
  }
  async function onToggle(): Promise<void> {
    await runAction(() => applyToggleTask(task.id, paused), 'toggleFailed')
  }
  async function onDelete(): Promise<void> {
    setConfirmOpen(false)
    const result = await applyDeleteTask(task.id)
    if (!result.ok) {
      const message = result.error ?? t('deleteFailed')
      setActionError(message)
      setToast({ text: message, seq: Date.now() })
      return
    }
    setActionError('')
  }

  const items: MenuEntry[] = [
    { id: 'run', label: t('runNow'), icon: <IconPlay /> },
    { id: 'toggle', label: paused ? t('resume') : t('pause'), icon: <IconPause /> },
    { type: 'separator', id: 'sep' },
    { id: 'delete', label: t('delete'), icon: <IconTrash />, danger: true },
  ]

  return (
    <li
      ref={cardRef}
      className={`${K.card}${paused ? ` ${K.cardPaused}` : ''}`}
      onClick={(event) => {
        // 仅当点击落在卡片本体（title/meta 文本）时打开编辑；portaled 的菜单列表 /
        // Modal 不是 li 的 DOM 后代，contains() 为 false，不触发编辑（避免误开弹窗）。
        if (event.currentTarget.contains(event.target as Node))
          onEdit(task)
      }}
    >
      <div style={{ height: 36 }}>
        <span
          className={K.taskToggle}
          aria-label={paused ? t('resume') : t('pause')}
          onClick={(event) => {
            event.stopPropagation()
            void onToggle()
          }}
        >
          {paused ? <IconPlay /> : <IconPause />}
        </span>
      </div>
      <div style={{ flex: 1 }}>
        <span className={K.cardTitle} title={task.name}>
          {task.name}
        </span>
        <div className={K.cardMeta}>
          <span className={K.cardMetaText}>
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
          if (id === 'run')
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
            className={K.iconButton}
            aria-label={task.name}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen(openState => !openState)
            }}
          >
            <IconMore size={12} />
          </button>
        )}
      />
      {actionError ? <p className={K.error} role="alert">{actionError}</p> : null}
      {toast !== null
        ? (
            <Toast
              key={toast.seq}
              text={toast.text}
              icon={<IconWarningOutline16 />}
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
            <button className={K.btn} type="button" onClick={() => setConfirmOpen(false)}>{t('cancel')}</button>
            <button className={`${K.btn} ${K.btnDanger}`} type="button" onClick={() => void onDelete()}>{t('deleteConfirmAction')}</button>
          </>
        )}
      />
    </li>
  )
}
