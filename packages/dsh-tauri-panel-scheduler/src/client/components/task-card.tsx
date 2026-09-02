/**
 * components/task-card.tsx — 任务列表卡片：名称 + 计划·下次运行 + [...] 菜单
 * （立即运行 / 暂停或恢复 / 删除）。
 */

import type { ReactElement } from 'react'
import type { TaskView, Translate } from '../types'
import { useEffect, useRef, useState } from 'react'
import { applyDeleteTask, applyRunTask, applyToggleTask } from '../store'
import { IconMore, IconPause, IconPlay, IconTrash } from './icons'

export interface TaskCardProps {
  task: TaskView
  t: Translate
  describe: string
  nextRun?: string
  paused: boolean
}

export function TaskCard({ task, t, describe, nextRun, paused }: TaskCardProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [actionError, setActionError] = useState('')

  // 点击外部关闭菜单。
  useEffect(() => {
    if (!menuOpen)
      return
    function onPointerDown(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node))
        setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  async function runAction(
    action: () => Promise<{ ok: boolean, error?: string }>,
    errorKey: 'runFailed' | 'toggleFailed' | 'deleteFailed',
  ): Promise<void> {
    const result = await action()
    if (!result.ok) {
      setActionError(result.error ?? t(errorKey))
      return
    }
    setMenuOpen(false)
    setConfirming(false)
    setActionError('')
  }

  function onRun(): void {
    void runAction(() => applyRunTask(task.id), 'runFailed')
  }
  function onToggle(): void {
    void runAction(() => applyToggleTask(task.id, paused), 'toggleFailed')
  }
  function onDelete(): void {
    void runAction(() => applyDeleteTask(task.id), 'deleteFailed')
  }

  function openMenu(): void {
    setMenuOpen(open => !open)
    setConfirming(false)
  }

  return (
    <li className={`dsch-card${paused ? ' is-paused' : ''}`}>
      <span className="dsch-cardTitle" title={task.name}>{task.name}</span>
      <div className="dsch-cardMeta">
        <span className="dsch-cardMetaText">
          {describe}
          {nextRun !== undefined
            ? (
                <>
                  {' · '}
                  <strong>
                    {t('nextRun')}
                    {' '}
                    {nextRun}
                  </strong>
                </>
              )
            : <strong>{t('paused')}</strong>}
        </span>
        <div className="dsch-menu" ref={menuRef}>
          <button
            className="dsch-more"
            type="button"
            aria-label={task.name}
            data-open={menuOpen ? 'true' : undefined}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={openMenu}
          >
            <IconMore />
          </button>
          {menuOpen
            ? (
                <div className="dsch-menuPanel" role="menu">
                  <button className="dsch-menuItem" type="button" role="menuitem" onClick={onRun}>
                    <IconPlay />
                    {t('runNow')}
                  </button>
                  <button className="dsch-menuItem" type="button" role="menuitem" onClick={onToggle}>
                    <IconPause />
                    {paused ? t('resume') : t('pause')}
                  </button>
                  {confirming
                    ? (
                        <button className="dsch-menuItem is-danger" type="button" role="menuitem" onClick={onDelete}>
                          <IconTrash />
                          {t('delete')}
                        </button>
                      )
                    : (
                        <button className="dsch-menuItem is-danger" type="button" role="menuitem" onClick={() => setConfirming(true)}>
                          <IconTrash />
                          {t('delete')}
                        </button>
                      )}
                </div>
              )
            : null}
        </div>
      </div>
      {actionError ? <p className="dsch-error" role="alert">{actionError}</p> : null}
    </li>
  )
}
