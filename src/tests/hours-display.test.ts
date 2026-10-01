import { describe, expect, it } from 'vitest'
import {
  buildUpcomingHoursExceptions,
  buildWeeklyHours,
  formatNextOpeningAt,
} from '../lib/hours'
import type { BusinessHour, SpecialHour } from '../types/domain'

describe('public restaurant hours display', () => {
  it('formats the next opening in the restaurant timezone with an explicit 24-hour clock', () => {
    expect(
      formatNextOpeningAt(
        '2026-10-01T22:30:00Z',
        'America/Argentina/Cordoba',
      ),
    ).toBe('01/10, 19:30 hs')
  })

  it('models the habitual week from Monday to Sunday with multiple and overnight shifts', () => {
    const hours: BusinessHour[] = [
      { id: 'monday-evening', dayOfWeek: 1, slotIndex: 1, opensAt: '19:30:00', closesAt: '23:30:00', spansNextDay: false },
      { id: 'monday-lunch', dayOfWeek: 1, slotIndex: 0, opensAt: '11:00:00', closesAt: '14:00:00', spansNextDay: false },
      { id: 'saturday', dayOfWeek: 6, slotIndex: 0, opensAt: '21:00:00', closesAt: '02:00:00', spansNextDay: true },
    ]

    const week = buildWeeklyHours(hours)

    expect(week.map((day) => day.label)).toEqual([
      'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo',
    ])
    expect(week[0]?.slots.map((slot) => slot.label)).toEqual([
      '11:00 a 14:00 hs',
      '19:30 a 23:30 hs',
    ])
    expect(week[1]?.slots).toEqual([])
    expect(week[5]?.slots[0]?.label).toBe('21:00 a 02:00 hs (día siguiente)')
  })

  it('groups upcoming exceptions, ignores past dates and lets a closure override its date', () => {
    const specialHours: SpecialHour[] = [
      { id: 'past', date: '2026-09-30', isClosed: true, slotIndex: 0, opensAt: null, closesAt: null, spansNextDay: false, reason: 'Anterior' },
      { id: 'closed', date: '2026-10-02', isClosed: true, slotIndex: 0, opensAt: null, closesAt: null, spansNextDay: false, reason: 'Evento privado' },
      { id: 'ignored-shift', date: '2026-10-02', isClosed: false, slotIndex: 1, opensAt: '20:00', closesAt: '23:00', spansNextDay: false, reason: null },
      { id: 'special-evening', date: '2026-10-03', isClosed: false, slotIndex: 1, opensAt: '19:00', closesAt: '01:00', spansNextDay: true, reason: 'Horario especial' },
      { id: 'special-lunch', date: '2026-10-03', isClosed: false, slotIndex: 0, opensAt: '11:00', closesAt: '14:00', spansNextDay: false, reason: 'Horario especial' },
    ]

    const exceptions = buildUpcomingHoursExceptions({
      specialHours,
      now: new Date('2026-10-01T22:30:00Z'),
      timeZone: 'America/Argentina/Cordoba',
      locale: 'es-AR',
    })

    expect(exceptions).toHaveLength(2)
    expect(exceptions[0]).toMatchObject({
      date: '2026-10-02',
      dateLabel: 'Viernes, 02/10',
      isClosed: true,
      reason: 'Evento privado',
      slots: [],
    })
    expect(exceptions[1]?.slots.map((slot) => slot.label)).toEqual([
      '11:00 a 14:00 hs',
      '19:00 a 01:00 hs (día siguiente)',
    ])
  })
})
