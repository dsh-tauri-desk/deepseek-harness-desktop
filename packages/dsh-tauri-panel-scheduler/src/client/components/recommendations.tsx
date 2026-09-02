import type { ReactElement } from 'react'
import type { ScheduleForm, Translate } from '../types'
import { useSyncExternalStore } from 'react'
import { SCHEDULER_CLASSES as K } from '../constants'
import { applyCreateTask } from '../store'
import { describeSchedule } from '../utils/schedule'
import { IconCalendar } from './icons'

/**
 * components/recommendations.tsx — 推荐（预置）定时任务，展示在任务列表下方。
 *
 * 每项 = 着色图标 + 名称 + 计划摘要 + 说明文案。点击不经编辑弹窗，**直接创建**
 * 任务；创建成功后该项从列表移除。若删除某个由推荐创建的任务（名称匹配其推荐项），
 * 该项**立刻**回到列表——已添加集合用微型 uSES 存储承载，add()/releaseTaskRecommendation
 * 都在成功时即时通知（不等待宿主刷新往返）。schedule 结构即 TaskFormState.schedule。
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

const RECOMMENDATIONS: Recommendation[] = [
  {
    id: 'weekly-review',
    nameKey: 'recReviewName',
    promptKey: 'recReviewPrompt',
    schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' },
    accent: '#8B6FF0',
    icon: IconCalendar,
    form: t => ({ name: t('recReviewName'), schedule: { kind: 'weekly', weekdays: ['FR'], time: '16:00' }, prompt: t('recReviewPrompt'), workspaceId: '', permission: 'read-only', provider: '', model: '', reasoningEffort: '' }),
  },
]

let version = 0
const listeners = new Set<() => void>()
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getVersion(): number {
  return version
}

/** 已添加成功的推荐 id（模块级，切 tab 重建后仍保持）。 */
const addedRecIds = new Set<string>()

/** 变更即通知订阅者（uSES），让推荐列表立刻重渲染。 */
function notifyRecommendationsChanged(): void {
  version += 1
  for (const listener of listeners)
    listener()
}

/**
 * 释放与某任务名称匹配的推荐（任务删除成功后调用），使该推荐项立刻回到列表。
 * @param name - 被删任务名称。
 * @param t - 翻译函数（按当前语言匹配推荐项名称）。
 */
export function releaseTaskRecommendation(name: string, t: Translate): void {
  for (const rec of RECOMMENDATIONS) {
    if (t(rec.nameKey) === name)
      addedRecIds.delete(rec.id)
  }
  notifyRecommendationsChanged()
}

export interface RecommendationsProps {
  t: Translate
}

/** 推荐（预置）定时任务列表：点击直接创建，成功后该项移除。 */
export function Recommendations({ t }: RecommendationsProps): ReactElement {
  useSyncExternalStore(subscribe, getVersion)

  async function add(rec: Recommendation): Promise<void> {
    const form = rec.form(t)
    const result = await applyCreateTask({
      name: form.name,
      schedule: form.schedule,
      prompt: form.prompt,
      workspaceId: form.workspaceId || undefined,
    })
    if (result.ok) {
      addedRecIds.add(rec.id)
      notifyRecommendationsChanged()
    }
  }

  const visible = RECOMMENDATIONS.filter(rec => !addedRecIds.has(rec.id))

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
