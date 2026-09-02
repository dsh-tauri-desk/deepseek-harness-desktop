/**
 * utils/schedule.ts — 计划描述与下次运行时间的展示格式化（纯函数）。
 */

import type { ScheduleForm, Translate, Weekday } from '../types'

const WEEKDAY_LABELS: Record<Weekday, string> = {
  MO: 'dayMon',
  TU: 'dayTue',
  WE: 'dayWed',
  TH: 'dayThu',
  FR: 'dayFri',
  SA: 'daySat',
  SU: 'daySun',
}

/** 把计划渲染成人类可读描述（与 ASCII 卡片一致：每天 09:00 / 间隔 30 分 / 工作日 09:00 / 星期五 09:00）。 */
export function describeSchedule(schedule: ScheduleForm, t: Translate): string {
  switch (schedule.kind) {
    case 'daily':
      return `${t('scheduleDaily')} ${schedule.time}`
    case 'interval':
      return `${t('scheduleInterval')} ${schedule.everyMinutes}${t('minuteShort')}`
    case 'workdays':
      return `${t('scheduleWorkdays')} ${schedule.time}`
    case 'weekly':
      return `${schedule.weekdays.map(day => t(WEEKDAY_LABELS[day])).join('/')} ${schedule.time}`
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

/** 计算 nextRunAt 相对当前时刻的自然语言描述（如「3 天后」「7 小时后」）。 */
export function formatRelative(iso: string | undefined, now: number, t: Translate): string {
  if (!iso)
    return t('never')
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target))
    return t('never')
  const diff = Math.max(0, target - now)
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60)
    return `${minutes}${t('unitMinutes')}`
  const hours = Math.round(diff / 3_600_000)
  if (hours < 24)
    return `${hours}${t('unitHours')}`
  const days = Math.round(diff / 86_400_000)
  return `${days}${t('unitDays')}`
}

/** 任务是否处于暂停态。 */
export function isTaskPaused(task: { enabled: boolean }): boolean {
  return !task.enabled
}
