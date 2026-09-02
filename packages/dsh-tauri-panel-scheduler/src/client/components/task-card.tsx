/**
 * components/task-card.tsx — 任务列表卡片：名称 + 计划 + 下次运行时间 + [...] 菜单
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
}

export function TaskCard({ task, t, describe, nextRun }: TaskCardProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

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

  const paused = !task.enabled
  const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : ''
  const [actionError, setActionError] = useState('')

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
    <li className={`dsch-card${paused ? ' dsch-cardMuted' : ''}`}>
      <div className="dsch-cardTop">
        <span className="dsch-cardTitle" title={task.name}>{task.name}</span>
        <span className="dsch-tag" data-kind={paused ? 'paused' : 'active'}>{paused ? t('paused') : t('active')}</span>
      </div>
      <p className="dsch-cardPrompt">{describe}</p>
      <div className="dsch-cardMeta">
        <span className="dsch-cardMetaRow">
          <span>
            {t('nextRun')}
            :
          </span>
          <span className="dsch-runTime">{nextRun ?? t('never')}</span>
        </span>
        {lastRun
          ? (
              <span className="dsch-cardMetaRow">
                <span>
                  {t('lastRun')}
                  :
                </span>
                <span className="dsch-runTime">{lastRun}</span>
              </span>
            )
          : null}
      </div>
      {actionError ? <p className="dsch-error" role="alert">{actionError}</p> : null}
      <div className="dsch-cardActions">
        <div className="dsch-menu" ref={menuRef}>
          <button
            className="dsch-menuButton"
            type="button"
            aria-label={t('scheduler')}
            data-open={menuOpen ? 'true' : undefined}
            aria-expanded={menuOpen}
            onClick={openMenu}
          >
            <IconMore />
          </button>
          {menuOpen
            ? (
                <div className="dsch-menuPanel">
                  <button className="dsch-menuItem" type="button" onClick={onRun}>
                    <IconPlay />
                    {t('runNow')}
                  </button>
                  <button className="dsch-menuItem" type="button" onClick={onToggle}>
                    <IconPause />
                    {paused ? t('resume') : t('pause')}
                  </button>
                  {confirming
                    ? (
                        <button className="dsch-menuItem dsch-menuItemDanger" type="button" onClick={onDelete}>
                          <IconTrash />
                          {t('confirmDeleteTitle')}
                        </button>
                      )
                    : (
                        <button className="dsch-menuItem dsch-menuItemDanger" type="button" onClick={() => setConfirming(true)}>
                          <IconTrash />
                          {t('delete')}
                        </button>
                      )}
                </div>
              )
            : null}
        </div>
      </div>
    </li>
  )
}
