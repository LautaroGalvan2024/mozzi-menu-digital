import { describe, expect, it } from 'vitest'
import {
  dateInTimeZone,
  dateRangeForLocalDates,
  dayRangeInTimeZone,
} from '../lib/timezone'

describe('restaurant-local reporting range', () => {
  it('uses the restaurant timezone rather than the browser timezone', () => {
    expect(dayRangeInTimeZone(new Date('2026-09-28T18:00:00Z'), 'America/Argentina/Cordoba')).toEqual({
      from: '2026-09-28T03:00:00.000Z',
      to: '2026-09-29T03:00:00.000Z',
    })
  })

  it('respects a daylight-saving transition', () => {
    const range = dayRangeInTimeZone(new Date('2026-03-08T12:00:00Z'), 'America/New_York')
    expect(range.from).toBe('2026-03-08T05:00:00.000Z')
    expect(range.to).toBe('2026-03-09T04:00:00.000Z')
  })

  it('returns the calendar date at the restaurant even across UTC boundaries', () => {
    const instant = new Date('2026-09-29T01:30:00Z')
    expect(dateInTimeZone(instant, 'America/Argentina/Cordoba')).toBe('2026-09-28')
    expect(dateInTimeZone(instant, 'Asia/Tokyo')).toBe('2026-09-29')
  })

  it('converts an inclusive local date filter into an exclusive UTC range', () => {
    expect(
      dateRangeForLocalDates('2026-09-28', '2026-09-30', 'America/Argentina/Cordoba'),
    ).toEqual({
      from: '2026-09-28T03:00:00.000Z',
      to: '2026-10-01T03:00:00.000Z',
    })
  })

  it('accounts for daylight saving inside a multi-day local range', () => {
    expect(dateRangeForLocalDates('2026-03-07', '2026-03-08', 'America/New_York')).toEqual({
      from: '2026-03-07T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    })
  })

  it('rejects impossible and reversed local dates', () => {
    expect(() => dateRangeForLocalDates('2026-02-30', '2026-03-01', 'UTC')).toThrow(
      'Fecha local inválida',
    )
    expect(() => dateRangeForLocalDates('2026-03-02', '2026-03-01', 'UTC')).toThrow(
      'El rango de fechas es inválido',
    )
  })
})
