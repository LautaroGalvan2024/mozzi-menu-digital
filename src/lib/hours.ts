import type { BusinessHour, SpecialHour } from '../types/domain'

const WEEK_DAYS = [
  { dayOfWeek: 1, label: 'Lunes' },
  { dayOfWeek: 2, label: 'Martes' },
  { dayOfWeek: 3, label: 'Miércoles' },
  { dayOfWeek: 4, label: 'Jueves' },
  { dayOfWeek: 5, label: 'Viernes' },
  { dayOfWeek: 6, label: 'Sábado' },
  { dayOfWeek: 0, label: 'Domingo' },
] as const

export interface DisplayHoursSlot {
  id: string
  label: string
  opensAt: string
  closesAt: string
  spansNextDay: boolean
}

export interface WeeklyHoursDay {
  dayOfWeek: number
  label: string
  slots: DisplayHoursSlot[]
}

export interface UpcomingHoursException {
  date: string
  dateLabel: string
  isClosed: boolean
  reason: string | null
  slots: DisplayHoursSlot[]
}

function minutes(value: string) {
  const [hours = '0', mins = '0'] = value.split(':')
  return Number(hours) * 60 + Number(mins)
}

function clockParts(value: string) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function formatClock(value: string) {
  const parsed = clockParts(value)
  if (!parsed) return value.trim()
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`
}

function displaySlot(slot: Pick<BusinessHour, 'id' | 'opensAt' | 'closesAt' | 'spansNextDay'>): DisplayHoursSlot {
  const opensAt = formatClock(slot.opensAt)
  const closesAt = formatClock(slot.closesAt)
  return {
    id: slot.id,
    opensAt,
    closesAt,
    spansNextDay: slot.spansNextDay,
    label: `${opensAt} a ${closesAt} hs${slot.spansNextDay ? ' (día siguiente)' : ''}`,
  }
}

function localDateKey(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year').padStart(4, '0')}-${value('month').padStart(2, '0')}-${value('day').padStart(2, '0')}`
}

function formatLocalDateLabel(value: string, locale: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
  }).format(date)
  const capitalizedWeekday = weekday.charAt(0).toLocaleUpperCase(locale) + weekday.slice(1)
  return `${capitalizedWeekday}, ${match[3]}/${match[2]}`
}

/** Formats an instant in the restaurant timezone, always using a 24-hour clock. */
export function formatNextOpeningAt(
  value: string | Date | null,
  timeZone: string,
): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    (parts.find((item) => item.type === type)?.value ?? '').padStart(2, '0')
  return `${part('day')}/${part('month')}, ${part('hour')}:${part('minute')} hs`
}

/** Returns the habitual schedule in display order, Monday through Sunday. */
export function buildWeeklyHours(businessHours: readonly BusinessHour[]): WeeklyHoursDay[] {
  return WEEK_DAYS.map(({ dayOfWeek, label }) => ({
    dayOfWeek,
    label,
    slots: businessHours
      .filter((slot) => slot.dayOfWeek === dayOfWeek)
      .sort((left, right) => left.slotIndex - right.slotIndex || left.opensAt.localeCompare(right.opensAt))
      .map(displaySlot),
  }))
}

/** Groups current and future exceptional hours by local calendar date. */
export function buildUpcomingHoursExceptions({
  specialHours,
  now,
  timeZone,
  locale,
}: {
  specialHours: readonly SpecialHour[]
  now: Date
  timeZone: string
  locale: string
}): UpcomingHoursException[] {
  const today = localDateKey(now, timeZone)
  const grouped = new Map<string, SpecialHour[]>()
  for (const entry of specialHours) {
    if (entry.date < today) continue
    grouped.set(entry.date, [...(grouped.get(entry.date) ?? []), entry])
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, entries]) => {
      const ordered = entries.sort(
        (left, right) => left.slotIndex - right.slotIndex || (left.opensAt ?? '').localeCompare(right.opensAt ?? ''),
      )
      const isClosed = ordered.some((entry) => entry.isClosed)
      const reasons = [...new Set(ordered.map((entry) => entry.reason?.trim()).filter(Boolean))]
      return {
        date,
        dateLabel: formatLocalDateLabel(date, locale),
        isClosed,
        reason: reasons.length > 0 ? reasons.join(' · ') : null,
        slots: isClosed
          ? []
          : ordered
              .filter((entry): entry is SpecialHour & { opensAt: string; closesAt: string } =>
                Boolean(entry.opensAt && entry.closesAt),
              )
              .map((entry) => displaySlot({
                id: entry.id,
                opensAt: entry.opensAt,
                closesAt: entry.closesAt,
                spansNextDay: entry.spansNextDay,
              })),
      }
    })
}

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '0'
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const date = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
  const utcDate = new Date(Date.UTC(year, month - 1, day))
  const previous = new Date(utcDate.getTime() - 86_400_000)
  return {
    date,
    dayOfWeek: utcDate.getUTCDay(),
    currentMinutes: hour * 60 + minute,
    previousDate: previous.toISOString().slice(0, 10),
    previousDayOfWeek: previous.getUTCDay(),
  }
}

function specialSlots(date: string, specials: SpecialHour[]) {
  const entries = specials.filter((entry) => entry.date === date)
  if (entries.length === 0) return null
  if (entries.some((entry) => entry.isClosed)) return []
  return entries
    .filter((entry) => entry.opensAt && entry.closesAt)
    .map((entry) => ({
      opensAt: entry.opensAt ?? '00:00',
      closesAt: entry.closesAt ?? '00:00',
      spansNextDay: entry.spansNextDay,
    }))
}

export function isRestaurantOpenAt({
  now,
  timeZone,
  businessHours,
  specialHours,
}: {
  now: Date
  timeZone: string
  businessHours: BusinessHour[]
  specialHours: SpecialHour[]
}) {
  const local = localParts(now, timeZone)
  const today =
    specialSlots(local.date, specialHours) ??
    businessHours.filter((slot) => slot.dayOfWeek === local.dayOfWeek)
  const yesterday =
    specialSlots(local.previousDate, specialHours) ??
    businessHours.filter((slot) => slot.dayOfWeek === local.previousDayOfWeek)

  const openToday = today.some((slot) => {
    const start = minutes(slot.opensAt)
    const end = minutes(slot.closesAt)
    return slot.spansNextDay
      ? local.currentMinutes >= start
      : local.currentMinutes >= start && local.currentMinutes < end
  })
  const openFromYesterday = yesterday.some(
    (slot) => slot.spansNextDay && local.currentMinutes < minutes(slot.closesAt),
  )
  return openToday || openFromYesterday
}
