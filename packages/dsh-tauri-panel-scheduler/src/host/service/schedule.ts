/**
 * host/service/schedule.ts — 调度计划的下次触发时间计算。
 *
 * 时间点类计划（daily / workdays / weekly）委托 cron-schedule 解析 5 段 cron
 * 表达式并求「下一个触发时刻」；interval 是纯间隔（无 cron 等价），保留锚点加法。
 * cron-schedule 在宿主本地时区上求值，与「电脑保持唤醒时运行」的产品语义一致
 * （schedule.timeZone 仅作展示记录，执行统一用宿主本地钟面时间）。返回 ms 时间戳。
 */

import type { SchedulerSchedule, Weekday } from '../types/index.js'
import { parseCronExpression } from 'cron-schedule'

const MINUTE_MS = 60 * 1000
/** 间隔上限（分钟）：1 年，防止超大间隔把 nextOccurrence 推到 Infinity/Invalid Date。 */
const MAX_EVERY_MINUTES = 525_600

/** 解析 "HH:mm" 为当日分钟数；非法返回 undefined。 */
export function parseTimeToMinutes(time: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match)
    return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
    return undefined
  return hours * 60 + minutes
}

/** 星期短名 → cron 星期字段值（0/7=周日，与 JS Date#getDay 一致）。 */
const WEEKDAY_TO_CRON_DAY: Record<Weekday, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 0,
}

/** 时间点类计划（有 cron 表达式可表达的三种 kind）。 */
type TimeSchedule = Extract<SchedulerSchedule, { kind: 'daily' | 'workdays' | 'weekly' }>

/**
 * 把「时间点 + 星期」计划映射为 5 段 cron 表达式（minute hour dom month dow）。
 * time 非法、weekly 无有效星期时返回 undefined（调用方按不可达处理）。
 */
function toCronExpression(schedule: TimeSchedule): string | undefined {
  const minutes = parseTimeToMinutes(schedule.time)
  if (minutes === undefined)
    return undefined
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  switch (schedule.kind) {
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'workdays':
      return `${minute} ${hour} * * 1-5`
    case 'weekly': {
      const days: number[] = []
      for (const day of schedule.weekdays) {
        if (!Object.hasOwn(WEEKDAY_TO_CRON_DAY, day))
          return undefined
        days.push(WEEKDAY_TO_CRON_DAY[day])
      }
      if (days.length === 0)
        return undefined
      return `${minute} ${hour} * * ${[...new Set(days)].sort((a, b) => a - b).join(',')}`
    }
  }
}

/**
 * 计算某个计划在 from（ms 时间戳）之后的首次触发时间。
 * 返回 ms 时间戳；计划非法或不可达时返回 undefined。
 */
export function nextOccurrence(schedule: SchedulerSchedule, from: number): number | undefined {
  switch (schedule.kind) {
    case 'interval': {
      const every = schedule.everyMinutes
      if (!Number.isFinite(every) || every < 1 || every > MAX_EVERY_MINUTES)
        return undefined
      // 以 from 为锚点：下一格（不重复触发当前已过的时刻）。
      return from + every * MINUTE_MS
    }
    case 'daily':
    case 'workdays':
    case 'weekly': {
      const expression = toCronExpression(schedule)
      if (expression === undefined)
        return undefined
      return parseCronExpression(expression).getNextDate(new Date(from)).getTime()
    }
  }
}

/** 校验计划是否合法（供创建/更新路由复用）。 */
export function validateSchedule(schedule: unknown): schedule is SchedulerSchedule {
  if (typeof schedule !== 'object' || schedule === null)
    return false
  const value = schedule as Partial<SchedulerSchedule>
  if (value.kind === 'interval') {
    return Number.isFinite(value.everyMinutes)
      && (value.everyMinutes as number) >= 1
      && (value.everyMinutes as number) <= MAX_EVERY_MINUTES
  }
  if (value.kind === 'daily' || value.kind === 'workdays') {
    return typeof value.time === 'string' && parseTimeToMinutes(value.time) !== undefined
  }
  if (value.kind === 'weekly') {
    return typeof value.time === 'string'
      && parseTimeToMinutes(value.time) !== undefined
      && Array.isArray(value.weekdays)
      && (value.weekdays as Weekday[]).length > 0
      && (value.weekdays as Weekday[]).every(day => Object.hasOwn(WEEKDAY_TO_CRON_DAY, day))
  }
  return false
}

/** 宿主本地 IANA 时区（默认展示用）。 */
export function localTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  catch {
    return 'UTC'
  }
}
