import type { BusinessHour, SpecialHour } from '../types/domain'

function minutes(value: string) {
  const [hours = '0', mins = '0'] = value.split(':')
  return Number(hours) * 60 + Number(mins)
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
