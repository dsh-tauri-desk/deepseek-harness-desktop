import type { ReactElement } from 'react'
import type { ScheduleForm, TaskFormState, TaskView, Translate } from '../types'
import { SCHEDULER_CLASSES as K } from '../constants'
import { applyCreateTask } from '../store'
import { recommendationMatchesTask } from '../utils/recommendations'
import { describeSchedule } from '../utils/schedule'
import { IconCalendar } from './icons'

/**
 * components/recommendations.tsx — 推荐（预置）定时任务，展示在任务列表下方。
 *
 * 推荐消费状态由任务记录中的 recommendationId 持久化承载；对旧版本创建的任务，
 * 仍用名称、计划和指令做兼容匹配。这样刷新页面或重新打开面板时，已添加项不会回到列表。
 */

interface IconLike {
  (props: { className?: string }): ReactElement
}

export interface Recommendation {
  id: string
  nameKey: string
  promptKey: string
  schedule: ScheduleForm
  accent: string
  icon: IconLike
  /** 构造可直接创建的表单（名称/计划/指令，其余取默认）。 */
  form: (t: Translate) => TaskFormState
}

export const RECOMMENDATIONS: Recommendation[] = [
  {
    id: 'weekly-review',
    nameKey: 'recReviewName',
    promptKey: 'recReviewPrompt',
    schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' },
    accent: '#8B6FF0',
    icon: IconCalendar,
    form: t => ({ name: t('recReviewName'), schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' }, prompt: t('recReviewPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
  {
    id: 'weekday-briefing',
    nameKey: 'recWeekdayBriefingName',
    promptKey: 'recWeekdayBriefingPrompt',
    schedule: { kind: 'workdays', time: '08:00' },
    accent: '#3D9A80',
    icon: IconCalendar,
    form: t => ({ name: t('recWeekdayBriefingName'), schedule: { kind: 'workdays', time: '08:00' }, prompt: t('recWeekdayBriefingPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
]

export interface RecommendationsProps {
  t: Translate
  tasks: TaskView[]
}

/** 推荐（预置）定时任务列表：点击直接创建，成功后该项从任务列表中消失。 */
export function Recommendations({ t, tasks }: RecommendationsProps): ReactElement {
  async function add(rec: Recommendation): Promise<void> {
    const form = rec.form(t)
    await applyCreateTask({
      name: form.name,
      schedule: form.schedule,
      prompt: form.prompt,
      workspaceId: form.workspaceId || undefined,
      recommendationId: rec.id,
      enabled: false,
    })
  }

  const visible = RECOMMENDATIONS.filter(rec => !tasks.some(task => recommendationMatchesTask(rec, task, t)))

  return (
    <section className={K.recs} aria-label={t('recommended')}>
      <h2 className={K.recTitle}>{t('recommended')}</h2>
      {visible.length === 0
        ? <p className={K.muted}>{t('recommendedEmpty')}</p>
        : (
            <ul className={K.recList}>
              {visible.map(rec => (
                <li key={rec.id}>
                  <button type="button" className={K.recItem} onClick={() => void add(rec)}>
                    <span className={K.recIcon} style={{ color: rec.accent }}>
                      <rec.icon />
                    </span>
                    <span className={K.recBody}>
                      <span className={K.recName}>
                        {t(rec.nameKey)}
                        {' '}
                        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{describeSchedule(rec.schedule, t)}</span>
                      </span>
                      <span className={K.recPrompt}>{t(rec.promptKey)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
