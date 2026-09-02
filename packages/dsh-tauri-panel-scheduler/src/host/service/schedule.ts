/**
 * host/service/schedule.ts — 调度计划的下次触发时间计算。
 *
 * 纯函数、无副作用，便于单测锁定 DST/跨天/跨周语义。时间一律用宿主本地时区
 * （与「电脑保持唤醒时运行」的产品语义一致），返回 ms 时间戳。
 */

import type { SchedulerSchedule, Weekday } from '../types/index.js'
import { WORKDAY_SET } from '../../shared/constants.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
/** 月份推进的保守上限（避免非法周次死循环）。 */
const MAX_FORWARD_DAYS = 366

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

/** 星期短名 → JS 的 getDay()（0=周日）。 */
const WEEKDAY_TO_JS_DAY: Record<Weekday, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 0,
}

/** 本地日期对象上按"当日 HH:mm"构造时间戳（不足/越界返回 undefined）。 */
function timeOnDay(date: Date, minutes: number): number | undefined {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const ts = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, mins, 0, 0).getTime()
  return Number.isNaN(ts) ? undefined : ts
}

/**
 * 计算某个计划在 from（ms 时间戳）之后的首次触发时间。
 * 返回 ms 时间戳；计划非法或不可达时返回 undefined。
 */
export function nextOccurrence(schedule: SchedulerSchedule, from: number): number | undefined {
  const anchor = new Date(from)
  switch (schedule.kind) {
    case 'interval': {
      const every = schedule.everyMinutes
      if (!Number.isFinite(every) || every < 1)
        return undefined
      // 以 from 为锚点：下一格（不重复触发当前已过的时刻）。
      return from + every * MINUTE_MS
    }
    case 'daily': {
      const minutes = parseTimeToMinutes(schedule.time)
      if (minutes === undefined)
        return undefined
      const today = timeOnDay(anchor, minutes)
      if (today === undefined)
        return undefined
      return today > from ? today : today + DAY_MS
    }
    case 'workdays': {
      const minutes = parseTimeToMinutes(schedule.time)
      if (minutes === undefined)
        return undefined
      for (let offset = 0; offset < MAX_FORWARD_DAYS; offset++) {
        const candidate = new Date(anchor.getTime() + offset * DAY_MS)
        const day = candidate.getDay()
        const weekday = Object.keys(WEEKDAY_TO_JS_DAY).find(
          key => WEEKDAY_TO_JS_DAY[key as Weekday] === day,
        ) as Weekday | undefined
        if (weekday === undefined || !WORKDAY_SET.has(weekday))
          continue
        const ts = timeOnDay(candidate, minutes)
        if (ts !== undefined && ts > from)
          return ts
      }
      return undefined
    }
    case 'weekly': {
      const minutes = parseTimeToMinutes(schedule.time)
      if (minutes === undefined)
        return undefined
      const weekdays = schedule.weekdays
      if (!Array.isArray(weekdays) || weekdays.length === 0)
        return undefined
      const targetDays = new Set(weekdays.map(day => WEEKDAY_TO_JS_DAY[day]))
      for (let offset = 0; offset < MAX_FORWARD_DAYS; offset++) {
        const candidate = new Date(anchor.getTime() + offset * DAY_MS)
        if (!targetDays.has(candidate.getDay()))
          continue
        const ts = timeOnDay(candidate, minutes)
        if (ts !== undefined && ts > from)
          return ts
      }
      return undefined
    }
  }
}

/** 校验计划是否合法（供创建/更新路由复用）。 */
export function validateSchedule(schedule: unknown): schedule is SchedulerSchedule {
  if (typeof schedule !== 'object' || schedule === null)
    return false
  const value = schedule as Partial<SchedulerSchedule>
  if (value.kind === 'interval') {
    return Number.isFinite(value.everyMinutes) && (value.everyMinutes as number) >= 1
  }
  if (value.kind === 'daily' || value.kind === 'workdays') {
    return typeof value.time === 'string' && parseTimeToMinutes(value.time) !== undefined
  }
  if (value.kind === 'weekly') {
    return typeof value.time === 'string'
      && parseTimeToMinutes(value.time) !== undefined
      && Array.isArray(value.weekdays)
      && (value.weekdays as Weekday[]).length > 0
      && (value.weekdays as Weekday[]).every(day => Object.hasOwn(WEEKDAY_TO_JS_DAY, day))
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
