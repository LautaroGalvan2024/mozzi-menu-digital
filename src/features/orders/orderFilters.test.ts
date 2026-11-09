import { describe, expect, it } from 'vitest'
import { activeOrderDatePreset, orderDatePresets, parseOrderListFilters } from './orderFilters'

describe('order date presets', () => {
  const now = new Date('2026-11-08T15:00:00Z')
  const presets = orderDatePresets(now, 'America/Argentina/Buenos_Aires')

  it('uses the restaurant-local calendar and inclusive ranges', () => {
    expect(presets).toEqual({
      today: { from: '2026-11-08', to: '2026-11-08' },
      yesterday: { from: '2026-11-07', to: '2026-11-07' },
      week: { from: '2026-11-02', to: '2026-11-08' },
      last15: { from: '2026-10-25', to: '2026-11-08' },
      month: { from: '2026-11-01', to: '2026-11-08' },
    })
  })

  it('recognizes presets and marks edited ranges as custom', () => {
    expect(activeOrderDatePreset('2026-11-02', '2026-11-08', presets)).toBe('week')
    expect(activeOrderDatePreset('2026-11-03', '2026-11-08', presets)).toBe('custom')
  })

  it('crosses month, year and leap-day boundaries with calendar dates', () => {
    const newYear = orderDatePresets(new Date('2026-01-01T12:00:00Z'), 'UTC')
    expect(newYear.yesterday).toEqual({ from: '2025-12-31', to: '2025-12-31' })
    expect(newYear.week).toEqual({ from: '2025-12-29', to: '2026-01-01' })
    expect(newYear.last15).toEqual({ from: '2025-12-18', to: '2026-01-01' })
    expect(newYear.month).toEqual({ from: '2026-01-01', to: '2026-01-01' })

    const leapYear = orderDatePresets(new Date('2028-03-01T12:00:00Z'), 'UTC')
    expect(leapYear.yesterday).toEqual({ from: '2028-02-29', to: '2028-02-29' })
  })

  it('uses the configured timezone instead of the browser calendar', () => {
    const instant = new Date('2026-01-01T02:00:00Z')
    expect(orderDatePresets(instant, 'America/Los_Angeles').today).toEqual({
      from: '2025-12-31', to: '2025-12-31',
    })
    expect(orderDatePresets(instant, 'Asia/Tokyo').today).toEqual({
      from: '2026-01-01', to: '2026-01-01',
    })
  })
})

describe('order filter URL', () => {
  it('keeps supported filters and exposes a zero-based page internally', () => {
    const result = parseOrderListFilters(new URLSearchParams({
      q: 'Lucía', status: 'accepted', fulfillment: 'pickup',
      from: '2026-10-01', to: '2026-10-31', page: '3', ignored: 'value',
    }), '2026-11-08')
    expect(result.filters).toEqual({
      search: 'Lucía', status: 'accepted', fulfillment: 'pickup',
      from: '2026-10-01', to: '2026-10-31', page: 2,
    })
    expect(result.canonical.toString()).toBe('q=Luc%C3%ADa&status=accepted&fulfillment=pickup&from=2026-10-01&to=2026-10-31&page=3')
  })

  it('normalizes malformed enums, dates and pages to safe defaults', () => {
    const result = parseOrderListFilters(new URLSearchParams({
      status: 'unknown', fulfillment: 'courier', from: '2026-11-09', to: '2026-11-08', page: '-4',
    }), '2026-11-08')
    expect(result.filters).toEqual({
      search: '', status: '', fulfillment: '',
      from: '2026-11-08', to: '2026-11-08', page: 0,
    })
    expect(result.canonical.toString()).toBe('from=2026-11-08&to=2026-11-08')
  })
})
