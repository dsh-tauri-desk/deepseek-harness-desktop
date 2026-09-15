import type { SchedulerSchedule, Weekday } from '../types'
import { parseCronExpression } from 'cron-schedule'
import { inRange, isArray, isEmpty, isFinite, isInteger, isNil, isNumber, isObject, isString, sortBy, uniq } from 'lodash-es'
import { WEEKDAYS } from '../../shared/constants'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const MAX_EVERY_MINUTES = 525_600
const MAX_EVERY_DAYS = 366

export function parseTimeToMinutes(time: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match)
    return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return inRange(hours, 0, 24) && inRange(minutes, 0, 60) ? hours * 60 + minutes : undefined
}

const WEEKDAY_TO_CRON_DAY: Record<Weekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 }
type TimeSchedule = Extract<SchedulerSchedule, { kind: 'daily' | 'workdays' | 'weekly' | 'monthly' }>

const isInstant = (value: unknown): boolean => isString(value) && isFinite(new Date(value).getTime())
const isTimeValue = (value: unknown): boolean => isString(value) && parseTimeToMinutes(value) !== undefined
const isMinuteValue = (value: unknown): boolean => isNumber(value) && isInteger(value) && inRange(value, 0, 60)
const isFiniteInRange = (value: unknown, end: number): boolean => isNumber(value) && isFinite(value) && inRange(value, 1, end)
const isIntegerInRange = (value: unknown, end: number): boolean => isNumber(value) && isInteger(value) && inRange(value, 1, end)

function toCronExpression(schedule: TimeSchedule): string | undefined {
  const minutes = parseTimeToMinutes(schedule.time)
  if (minutes === undefined)
    return undefined
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  if (schedule.kind === 'daily')
    return `${minute} ${hour} * * *`
  if (schedule.kind === 'workdays')
    return `${minute} ${hour} * * 1-5`
  if (schedule.kind === 'monthly')
    return `${minute} ${hour} ${schedule.day} * *`
  const days = sortBy(uniq(schedule.weekdays.map(day => WEEKDAY_TO_CRON_DAY[day])))
  return isEmpty(days) ? undefined : `${minute} ${hour} * * ${days.join(',')}`
}

function anchoredOccurrence(anchor: string, step: number, from: number): number | undefined {
  const base = new Date(anchor).getTime()
  if (!isFinite(base) || step <= 0)
    return undefined
  const index = Math.max(0, Math.floor((from - base) / step) + 1)
  return base + index * step
}

export function nextOccurrence(schedule: SchedulerSchedule, from: number): number | undefined {
  switch (schedule.kind) {
    case 'once': {
      const at = new Date(schedule.at).getTime()
      return isFinite(at) && at > from ? at : undefined
    }
    case 'hourly': {
      if (!isMinuteValue(schedule.minute))
        return undefined
      const next = new Date(from + MINUTE_MS)
      next.setMinutes(schedule.minute, 0, 0)
      if (next.getTime() <= from)
        next.setHours(next.getHours() + 1)
      return next.getTime()
    }
    case 'interval':
      if (!isFiniteInRange(schedule.everyMinutes, MAX_EVERY_MINUTES + 1))
        return undefined
      return schedule.anchor ? anchoredOccurrence(schedule.anchor, schedule.everyMinutes * MINUTE_MS, from) : from + schedule.everyMinutes * MINUTE_MS
    case 'custom':
      if (!isIntegerInRange(schedule.everyDays, MAX_EVERY_DAYS + 1) || !isTimeValue(schedule.time))
        return undefined
      return anchoredOccurrence(schedule.anchor, schedule.everyDays * DAY_MS, from)
    case 'daily': case 'workdays': case 'weekly': case 'monthly': {
      const expression = toCronExpression(schedule)
      return expression === undefined ? undefined : parseCronExpression(expression).getNextDate(new Date(from)).getTime()
    }
  }
}

export function validateSchedule(schedule: unknown): schedule is SchedulerSchedule {
  if (!isObject(schedule))
    return false
  const value = schedule as Partial<SchedulerSchedule>
  switch (value.kind) {
    case 'once':
      return isInstant(value.at)
    case 'hourly':
      return isMinuteValue(value.minute)
    case 'interval':
      return isFiniteInRange(value.everyMinutes, MAX_EVERY_MINUTES + 1) && (isNil(value.anchor) || isInstant(value.anchor))
    case 'custom':
      return isIntegerInRange(value.everyDays, MAX_EVERY_DAYS + 1) && isInstant(value.anchor) && isTimeValue(value.time)
    case 'daily': case 'workdays':
      return isTimeValue(value.time)
    case 'monthly':
      return isIntegerInRange(value.day, 32) && isTimeValue(value.time)
    case 'weekly':
      return isTimeValue(value.time) && isArray(value.weekdays) && !isEmpty(value.weekdays) && value.weekdays.every(day => WEEKDAYS.includes(day))
    default:
      return false
  }
}

export function localTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  catch {
    return 'UTC'
  }
}
