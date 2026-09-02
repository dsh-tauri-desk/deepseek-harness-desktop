/**
 * components/scheduler-panel.tsx — 定时任务面板主容器。
 *
 * 布局对齐 issue #307 的 ASCII 设计图：
 *   标题 + 副标题 → 工具栏（搜索 / 通过 Chat 创建 / 手动创建 / 刷新）
 *   → 唤醒提示横幅 → Tabs（定时任务 / 执行记录）→ 任务卡片网格。
 *
 * 数据经 schedulerStore（uSES）订阅，轮询由本组件生命周期驱动。
 */

import type { ReactElement } from 'react'
import type { SchedulerPanelProps } from '../types'
import { useEffect, useState } from 'react'
import { REFRESH_INTERVAL_MS } from '../constants'
import { refreshScheduler, useSchedulerState } from '../store'
import { describeSchedule, formatRelative, isTaskPaused } from '../utils/schedule'
import { IconChat, IconInfo, IconPlus, IconRefresh, IconSearch } from './icons'
import { RunsTab } from './runs-tab'
import { TaskCard } from './task-card'
import { TaskCreateDialog } from './task-create-dialog'

export function SchedulerPanel({ t, onViaChat }: SchedulerPanelProps): ReactElement {
  const state = useSchedulerState()
  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  // 相对「下次运行」以刷新时刻为基准，避免每次渲染抖动。
  const [now, setNow] = useState(() => Date.now())

  // 轮询刷新：任务下次运行时间与执行记录跟随；同时推进相对时间基准。
  useEffect(() => {
    void refreshScheduler(true)
    const timer = window.setInterval(() => {
      void refreshScheduler(false)
      setNow(Date.now())
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  const filtered = search
    ? state.tasks.filter(task => `${task.name} ${task.prompt}`.toLowerCase().includes(search.toLowerCase()))
    : state.tasks

  return (
    <div className="dsch-shell">
      <header className="dsch-top">
        <div className="dsch-heading">
          <h1>{t('scheduler')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <div className="dsch-toolbar">
          <div className="dsch-searchWrap">
            <IconSearch className="dsch-searchIcon" />
            <input
              className="dsch-search"
              type="search"
              aria-label={t('searchPlaceholder')}
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
          </div>
          <button className="dsch-btn" type="button" onClick={onViaChat}>
            <IconChat />
            {t('viaChat')}
          </button>
          <button className="dsch-btn dsch-btn--primary" type="button" onClick={() => setCreateOpen(true)}>
            <IconPlus />
            {t('createManual')}
          </button>
          <button className="dsch-iconBtn" type="button" aria-label={t('refresh')} title={t('refresh')} onClick={() => void refreshScheduler(true)}>
            <IconRefresh />
          </button>
        </div>
      </header>

      <div className="dsch-banner" role="note">
        <span>
          <IconInfo />
          {t('wakeHint')}
        </span>
      </div>

      <div className="dsch-tabs" role="tablist" aria-label={t('scheduler')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tasks'}
          className={tab === 'tasks' ? 'dsch-tab is-on' : 'dsch-tab'}
          onClick={() => setTab('tasks')}
        >
          {t('tasksTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'runs'}
          className={tab === 'runs' ? 'dsch-tab is-on' : 'dsch-tab'}
          onClick={() => setTab('runs')}
        >
          {t('runsTab')}
        </button>
      </div>

      {state.error ? <p className="dsch-error" role="alert">{state.error}</p> : null}

      {tab === 'tasks'
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
                        describe={describeSchedule(task.schedule, t)}
                        nextRun={task.enabled ? formatRelative(task.nextRunAt, now, t) : undefined}
                        paused={isTaskPaused(task)}
                      />
                    ))}
                  </ul>
                )
          )
        : <RunsTab t={t} runs={state.runs} />}

      {createOpen
        ? <TaskCreateDialog t={t} options={state.options} onClose={() => setCreateOpen(false)} />
        : null}
    </div>
  )
}
