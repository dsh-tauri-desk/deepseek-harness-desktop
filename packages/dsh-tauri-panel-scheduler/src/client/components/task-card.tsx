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

  function onRun(): void {
    setMenuOpen(false)
    void applyRunTask(task.id)
  }
  function onToggle(): void {
    setMenuOpen(false)
    void applyToggleTask(task.id, paused)
  }
  function onDelete(): void {
    setMenuOpen(false)
    void applyDeleteTask(task.id)
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
