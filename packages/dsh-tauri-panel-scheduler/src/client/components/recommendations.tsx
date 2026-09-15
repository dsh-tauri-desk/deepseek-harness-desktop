import type { IconComponent } from 'dsh-tauri-ui/client'
import type { ReactElement } from 'react'
import type { LocaleKey, Translate } from '../locales/index.types'
import type { ScheduleForm, TaskFormState, TaskView } from '../types'
import { Calendar, Icon, useMountStyle } from 'dsh-tauri-ui/client'
import { RECOMMENDATIONS_STYLE_ID } from '../constants'
import { createTask } from '../service/scheduler'
import recommendationsStyle from './recommendations.cssr'
import { recommendationMatchesTask } from './recommendations.utils'
import { describeSchedule } from './schedule.utils'

type IconLike = IconComponent

export interface Recommendation {
  id: string
  nameKey: LocaleKey
  promptKey: LocaleKey
  schedule: ScheduleForm
  accent: string
  icon: IconLike
  form: (t: Translate) => TaskFormState
}

export const RECOMMENDATIONS: Recommendation[] = [
  {
    id: 'weekly-review',
    nameKey: 'recReviewName',
    promptKey: 'recReviewPrompt',
    schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' },
    accent: '#8B6FF0',
    icon: Calendar,
    form: t => ({ name: t('recReviewName'), schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' }, prompt: t('recReviewPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
  {
    id: 'weekday-briefing',
    nameKey: 'recWeekdayBriefingName',
    promptKey: 'recWeekdayBriefingPrompt',
    schedule: { kind: 'workdays', time: '08:00' },
    accent: '#3D9A80',
    icon: Calendar,
    form: t => ({ name: t('recWeekdayBriefingName'), schedule: { kind: 'workdays', time: '08:00' }, prompt: t('recWeekdayBriefingPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
]

export interface RecommendationsProps {
  t: Translate
  /** 只读：直接消费 store snapshot。 */
  tasks: readonly TaskView[]
}

/** 推荐（预置）定时任务列表：点击直接创建，成功后该项从任务列表中消失。 */
export function Recommendations({ t, tasks }: RecommendationsProps): ReactElement {
  useMountStyle(recommendationsStyle, RECOMMENDATIONS_STYLE_ID)
  async function add(rec: Recommendation): Promise<void> {
    const form = rec.form(t)
    await createTask({
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
    <section className="dshp-scheduler__recs" aria-label={t('recommended')}>
      <h2 className="dshp-scheduler__recs-title">{t('recommended')}</h2>
      {visible.length === 0
        ? <p className="dshp-scheduler__muted">{t('recommendedEmpty')}</p>
        : (
            <ul className="dshp-scheduler__recs-list">
              {visible.map(rec => (
                <li key={rec.id}>
                  <button type="button" className="dshp-scheduler__recs-item" onClick={() => void add(rec)}>
                    <span className="dshp-scheduler__recs-icon" style={{ color: rec.accent }}>
                      <Icon as={rec.icon} />
                    </span>
                    <span className="dshp-scheduler__recs-body">
                      <span className="dshp-scheduler__recs-name">
                        {t(rec.nameKey)}
                        {' '}
                        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{describeSchedule(rec.schedule, t)}</span>
                      </span>
                      <span className="dshp-scheduler__recs-prompt">{t(rec.promptKey)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
