import { describe, expect, it } from 'vitest'
import { DeliverySchedule, emptyDeliveryPolicy, formatDeliveryDate, isCalendarDate, type DeliveryPolicyInput } from './delivery-schedule'

const zone = 'America/Argentina/Buenos_Aires'
const policy = (changes: Partial<DeliveryPolicyInput> = {}) => new DeliverySchedule({
  ...emptyDeliveryPolicy(), menuEnabled: true, weekdays: [2, 5], ...changes,
})

describe('automatic delivery date preview', () => {
  it('keeps disabled calendars out of the existing flow', () => {
    expect(new DeliverySchedule(emptyDeliveryPolicy()).nextDate(new Date('2026-11-19T18:00:00Z'), zone)).toBeNull()
  })
  it('uses the prior calendar day cutoff and excludes its exact boundary', () => {
    expect(policy().nextDate(new Date('2026-11-19T20:59:59Z'), zone)).toBe('2026-11-20')
    expect(policy().nextDate(new Date('2026-11-19T21:00:00Z'), zone)).toBe('2026-11-24')
  })
  it('supports a same-day cutoff and skips closed delivery dates', () => {
    const schedule = policy({ cutoffDayOffset: 0, closedDates: ['2026-11-24'] })
    expect(schedule.nextDate(new Date('2026-11-20T20:59:59Z'), zone)).toBe('2026-11-20')
    expect(schedule.nextDate(new Date('2026-11-20T21:00:00Z'), zone)).toBe('2026-11-27')
  })
  it('uses the commerce timezone across a UTC midnight and a year boundary', () => {
    expect(policy({ weekdays: [4], cutoffDayOffset: 0, cutoffTime: '23:00' }).nextDate(new Date('2027-01-01T01:00:00Z'), zone)).toBe('2026-12-31')
  })
  it('handles local cutoff times around daylight saving changes', () => {
    expect(policy({ weekdays: [0], cutoffDayOffset: 0, cutoffTime: '03:00' }).nextDate(new Date('2026-03-08T06:59:00Z'), 'America/New_York')).toBe('2026-03-08')
    expect(policy({ weekdays: [0], cutoffDayOffset: 0, cutoffTime: '03:00' }).nextDate(new Date('2026-03-08T07:00:00Z'), 'America/New_York')).toBe('2026-03-15')
  })
  it('validates dates, requires days when enabled and returns detached normalized input', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(() => policy({ weekdays: [] })).toThrow('Elegí al menos un día de reparto.')
    const schedule = policy({ weekdays: [5, 2, 2] })
    const exported = schedule.toInput()
    expect(exported.weekdays).toEqual([2, 5])
    exported.weekdays.length = 0
    expect(schedule.toInput().weekdays).toEqual([2, 5])
  })
  it('formats a calendar date without shifting it to the previous day', () => {
    expect(formatDeliveryDate('2026-11-20')).toBe('viernes, 20 de noviembre')
  })
})
