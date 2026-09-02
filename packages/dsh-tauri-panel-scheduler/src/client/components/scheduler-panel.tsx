/**
 * components/scheduler-panel.tsx — 定时任务面板主容器：两个 tab（定时任务/执行记录）
 * + 搜索/新建/刷新 + 顶部唤醒提示条。
 *
 * 数据经 schedulerStore（uSES）订阅，polling 由本组件生命周期驱动；
 * 新建对话框由 TaskCreateDialog 管理。
 */

import type { ReactElement } from 'react'
import type { SchedulerPanelProps } from '../types'
import { useEffect, useId, useRef, useState } from 'react'
import { REFRESH_INTERVAL_MS } from '../constants'
import { refreshScheduler, useSchedulerState } from '../store'
import { describeSchedule, formatLocalTime } from '../utils/schedule'
import { IconChat, IconPlus, IconRefresh } from './icons'
import { RunsTab } from './runs-tab'
import { TaskCard } from './task-card'
import { TaskCreateDialog } from './task-create-dialog'

export function SchedulerPanel({ t, onViaChat }: SchedulerPanelProps): ReactElement {
  const state = useSchedulerState()
  const tabsId = useId()
  const tabRefsRef = useRef<Array<HTMLButtonElement | null>>([])
  const rows = [{ id: 'tasks', label: t('tasksTab') }, { id: 'runs', label: t('runsTab') }]
  const [activeId, setActiveId] = useState('tasks')
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(['tasks']))
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  // 轮询刷新：任务下次运行时间与执行记录跟随。
  useEffect(() => {
    void refreshScheduler(true)
    const timer = window.setInterval(() => {
      void refreshScheduler(false)
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    setVisited(previous => previous.has(activeId) ? previous : new Set([...previous, activeId]))
  }, [activeId])

  const filtered = search
    ? state.tasks.filter(task => task.name.toLowerCase().includes(search.toLowerCase()))
    : state.tasks

  const scheduleLabels = {
    daily: t('scheduleDaily'),
    interval: t('scheduleInterval'),
    workdays: t('scheduleWorkdays'),
    weekly: t('scheduleWeekly'),
    everyMinutes: t('scheduleEveryMinutes'),
  }

  return (
    <div className="dsch-section">
      <div className="dsch-banner">{t('wakeHint')}</div>

      <div className="dsch-head">
        <h2>{t('scheduler')}</h2>
        <div className="dsch-spacer" />
        <input
          className="dsch-search"
          type="search"
          aria-label={t('searchPlaceholder')}
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <button className="dsch-button dsch-buttonGhost" type="button" aria-label={t('viaChat')} title={t('viaChat')} onClick={onViaChat}>
          <IconChat />
        </button>
        <button className="dsch-button dsch-buttonIcon" type="button" aria-label={t('refresh')} title={t('refresh')} onClick={() => void refreshScheduler(true)}>
          <IconRefresh />
        </button>
        <button className="dsch-button dsch-buttonPrimary" type="button" onClick={() => setCreateOpen(true)}>
          <IconPlus />
          {t('createTask')}
        </button>
      </div>

      <div className="dsch-tabs" role="tablist" aria-label={t('scheduler')}>
        {rows.map((row, index) => {
          const selected = row.id === activeId
          return (
            <button
              key={row.id}
              ref={(element) => { tabRefsRef.current[index] = element }}
              id={`${tabsId}-tab-${row.id}`}
              type="button"
              role="tab"
              className="dsch-tab"
              aria-selected={selected}
              aria-controls={`${tabsId}-panel-${row.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(row.id)}
              onKeyDown={(event) => {
                let next: number
                if (event.key === 'ArrowRight')
                  next = (index + 1) % rows.length
                else if (event.key === 'ArrowLeft')
                  next = (index - 1 + rows.length) % rows.length
                else if (event.key === 'Home')
                  next = 0
                else if (event.key === 'End')
                  next = rows.length - 1
                else return
                event.preventDefault()
                setActiveId(rows[next]?.id ?? 'tasks')
                tabRefsRef.current[next]?.focus()
              }}
            >
              {row.label}
            </button>
          )
        })}
      </div>

      {state.error ? <p className="dsch-error" role="alert">{state.error}</p> : null}

      {rows.filter(row => row.id === activeId || visited.has(row.id)).map((row) => {
        const selected = row.id === activeId
        return (
          <div key={row.id} id={`${tabsId}-panel-${row.id}`} className="dsch-tabPanel" role="tabpanel" aria-labelledby={`${tabsId}-tab-${row.id}`} hidden={!selected}>
            {row.id === 'tasks'
              ? (
                  filtered.length === 0
                    ? <p className="dsch-empty">{search ? t('noMatch') : t('emptyTasks')}</p>
                    : (
                        <ul className="dsch-cards">
                          {filtered.map(task => (
                            <TaskCard
                              key={task.id}
                              task={task}
                              t={t}
                              describe={describeSchedule(task.schedule, scheduleLabels)}
                              nextRun={formatLocalTime(task.nextRunAt)}
                            />
                          ))}
                        </ul>
                      )
                )
              : <RunsTab t={t} runs={state.runs} />}
          </div>
        )
      })}

      {createOpen
        ? <TaskCreateDialog t={t} options={state.options} onClose={() => setCreateOpen(false)} />
        : null}
    </div>
  )
}
