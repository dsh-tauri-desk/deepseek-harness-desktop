/**
 * utils/schedule.ts — 计划描述与下次运行时间的展示格式化（纯函数）。
 *
 * 时间格式化委托 date-fns（format / differenceIn*），替换手写的 Intl 与差值算法；
 * 单位文案仍走 t() 以支持 zh/en 双语。date-fns 由 dsh-tauri/client 承载并在构建期
 * 按使用导出 tree-shake 内联，本插件 client 不直接 import 外部依赖。
 */

import type { ScheduleForm, Translate, Weekday } from '../types'
import { differenceInDays, differenceInHours, differenceInMinutes, format } from 'dsh-tauri/client'

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
  return format(date, 'MM/dd HH:mm')
}

/** 计算 nextRunAt 相对当前时刻的自然语言描述（如「3 天」「7 小时」）。 */
export function formatRelative(iso: string | undefined, now: number, t: Translate): string {
  if (!iso)
    return t('never')
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target))
    return t('never')
  const minutes = Math.max(0, differenceInMinutes(target, now))
  if (minutes < 60)
    return `${minutes}${t('unitMinutes')}`
  const hours = Math.max(0, differenceInHours(target, now))
  if (hours < 24)
    return `${hours}${t('unitHours')}`
  const days = Math.max(0, differenceInDays(target, now))
  return `${days}${t('unitDays')}`
}

/** 任务是否处于暂停态。 */
export function isTaskPaused(task: { enabled: boolean }): boolean {
  return !task.enabled
}
