/**
 * utils/schedule.ts — 计划描述与下次运行时间的展示格式化（纯函数）。
 */

import type { ScheduleForm, TaskView } from '../types'

const WEEKDAY_LABELS: Record<string, string> = {
  MO: 'MO',
  TU: 'TU',
  WE: 'WE',
  TH: 'TH',
  FR: 'FR',
  SA: 'SA',
  SU: 'SU',
}

/** 把计划渲染成人类可读描述（多语言由调用方传入映射）。 */
export function describeSchedule(schedule: ScheduleForm, labels: {
  daily: string
  interval: string
  workdays: string
  weekly: string
  everyMinutes: string
}): string {
  switch (schedule.kind) {
    case 'daily':
      return `${labels.daily} ${schedule.time}`
    case 'interval':
      return `${labels.interval} ${schedule.everyMinutes}${labels.everyMinutes}`
    case 'workdays':
      return `${labels.workdays} ${schedule.time}`
    case 'weekly':
      return `${labels.weekly} ${schedule.weekdays.map(day => WEEKDAY_LABELS[day] ?? day).join('/')} ${schedule.time}`
  }
}

/** 把 ISO 时间格式化为本地可读时间（非法/空返回 undefined）。 */
export function formatLocalTime(iso: string | undefined): string | undefined {
  if (!iso)
    return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return undefined
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** 任务是否处于暂停态。 */
export function isTaskPaused(task: TaskView): boolean {
  return !task.enabled
}
