import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  it('interval rejects oversized everyMinutes (would overflow Date)', () => {
    expect(nextOccurrence({ kind: 'interval', everyMinutes: Number.MAX_SAFE_INTEGER, timeZone: 'UTC' }, Date.now())).toBeUndefined()
    expect(nextOccurrence({ kind: 'interval', everyMinutes: 1e9, timeZone: 'UTC' }, Date.now())).toBeUndefined()
    expect(validateSchedule({ kind: 'interval', everyMinutes: 1e9, timeZone: 'UTC' })).toBe(false)
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

describe('nextOccurrence across DST (America/New_York)', () => {
  const originalTZ = process.env.TZ

  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })

  afterAll(() => {
    if (originalTZ === undefined)
      delete process.env.TZ
    else
      process.env.TZ = originalTZ
  })

  it('daily keeps the same wall-clock time across spring-forward', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT（春季前拨，当天只有 23 小时）。
    // 从 03-07 09:00 之后找 08:00 → 应为 03-08 08:00 EDT。
    const from = new Date(2026, 2, 7, 9, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'America/New_York' }, from)
    const expected = new Date(2026, 2, 8, 8, 0, 0).getTime()
    expect(next).toBe(expected)
    // 与「日历日 +1」一致：加 24h 毫秒会得到 23 小时的钟面错位。
    expect(new Date(next as number).getHours()).toBe(8)
  })

  it('daily keeps the same wall-clock time across fall-back', () => {
    // 2026-11-01 02:00 EDT → 01:00 EST（秋季回拨，当天 25 小时）。
    const from = new Date(2026, 9, 31, 9, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'daily', time: '08:00', timeZone: 'America/New_York' }, from)
    const expected = new Date(2026, 10, 1, 8, 0, 0).getTime()
    expect(next).toBe(expected)
    expect(new Date(next as number).getHours()).toBe(8)
  })

  it('workdays keeps wall-clock time across a DST boundary', () => {
    // 2026-03-06（周五）之后的工作日 08:00：跨 03-08 春季前拨 → 03-09（周一）08:00。
    const friday = new Date(2026, 2, 6, 12, 0, 0).getTime()
    const next = nextOccurrence({ kind: 'workdays', time: '08:00', timeZone: 'America/New_York' }, friday)
    expect(next).toBe(new Date(2026, 2, 9, 8, 0, 0).getTime())
  })
})
