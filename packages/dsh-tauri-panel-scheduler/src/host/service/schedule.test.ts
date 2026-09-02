import { describe, expect, it } from 'vitest'
import { nextOccurrence, parseTimeToMinutes, validateSchedule } from './schedule'

describe('parseTimeToMinutes', () => {
  it('parses "HH:mm" into minutes since midnight', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0)
    expect(parseTimeToMinutes('08:30')).toBe(510)
    expect(parseTimeToMinutes('23:59')).toBe(1439)
  })

  it('rejects invalid formats and out-of-range values', () => {
    expect(parseTimeToMinutes('')).toBeUndefined()
    expect(parseTimeToMinutes('8')).toBeUndefined()
    expect(parseTimeToMinutes('24:00')).toBeUndefined()
    expect(parseTimeToMinutes('08:60')).toBeUndefined()
    expect(parseTimeToMinutes('ab:cd')).toBeUndefined()
  })
})

describe('nextOccurrence', () => {
  it('interval returns from + everyMinutes', () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0)
    const next = nextOccurrence({ kind: 'interval', everyMinutes: 30, timeZone: 'UTC' }, from)
    expect(next).toBe(from + 30 * 60 * 1000)
  })

  it('daily returns today at time when still in the future', () => {
    // 2026-01-01 08:00 local
    const from = new Date(2026, 0, 1, 7, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, from)
    expect(next).toBe(new Date(2026, 0, 1, 8, 0, 0).getTime())
  })

  it('daily rolls to tomorrow when the time already passed', () => {
    const from = new Date(2026, 0, 1, 9, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'UTC' }, from)
    expect(next).toBe(new Date(2026, 0, 2, 8, 0, 0).getTime())
  })

  it('workdays skips weekends', () => {
    // 2026-01-03 是周六
    const saturday = new Date(2026, 0, 3, 9, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'workdays', time: '08:00', timeZone: 'UTC' }, saturday)
    // 下一个工作日是周一 2026-01-05
    expect(next).toBe(new Date(2026, 0, 5, 8, 0, 0).getTime())
  })

  it('weekly picks the next selected weekday', () => {
    // 2026-01-01 是周四；选 MO/WE → 下一个选中的是周一 2026-01-05
    const thursday = new Date(2026, 0, 1, 9, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'weekly', weekdays: ['MO', 'WE'], time: '08:00', timeZone: 'UTC' }, thursday)
    expect(next).toBe(new Date(2026, 0, 5, 8, 0, 0).getTime())
  })

  it('returns undefined for invalid schedules', () => {
    expect(nextOccurrence({ kind: 'interval', everyMinutes: 0, timeZone: 'UTC' }, Date.now())).toBeUndefined()
    expect(nextOccurrence({ kind: 'daily', time: 'bad', timeZone: 'UTC' }, Date.now())).toBeUndefined()
    expect(nextOccurrence({ kind: 'weekly', weekdays: [], time: '08:00', timeZone: 'UTC' }, Date.now())).toBeUndefined()
  })
})

describe('validateSchedule', () => {
  it('accepts all four valid kinds', () => {
    expect(validateSchedule({ kind: 'daily', time: '08:00', timeZone: 'UTC' })).toBe(true)
    expect(validateSchedule({ kind: 'interval', everyMinutes: 30, timeZone: 'UTC' })).toBe(true)
    expect(validateSchedule({ kind: 'workdays', time: '09:30', timeZone: 'UTC' })).toBe(true)
    expect(validateSchedule({ kind: 'weekly', weekdays: ['MO', 'FR'], time: '10:00', timeZone: 'UTC' })).toBe(true)
  })

  it('rejects invalid shapes', () => {
    expect(validateSchedule({ kind: 'daily', time: '25:00' })).toBe(false)
    expect(validateSchedule({ kind: 'interval', everyMinutes: -1 })).toBe(false)
    expect(validateSchedule({ kind: 'weekly', weekdays: ['XX'], time: '08:00' })).toBe(false)
    expect(validateSchedule(null)).toBe(false)
    expect(validateSchedule('nope')).toBe(false)
  })
})
