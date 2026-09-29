function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string) {
  const target = Date.UTC(year, month - 1, day)
  let candidate = target
  // Iteration handles UTC offsets and daylight-saving changes without a date library.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = zonedParts(new Date(candidate), timeZone)
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    )
    const correction = target - representedUtc
    candidate += correction
    if (correction === 0) break
  }
  return new Date(candidate)
}

function formatLocalDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new RangeError(`Fecha local inválida: ${value}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const represented = new Date(Date.UTC(year, month - 1, day))
  if (
    represented.getUTCFullYear() !== year ||
    represented.getUTCMonth() + 1 !== month ||
    represented.getUTCDate() !== day
  ) {
    throw new RangeError(`Fecha local inválida: ${value}`)
  }
  return { year, month, day }
}

export function dateInTimeZone(now: Date, timeZone: string) {
  const local = zonedParts(now, timeZone)
  return formatLocalDate(local.year, local.month, local.day)
}

export function dateRangeForLocalDates(from: string, to: string, timeZone: string) {
  const start = parseLocalDate(from)
  const inclusiveEnd = parseLocalDate(to)
  const followingEnd = new Date(
    Date.UTC(inclusiveEnd.year, inclusiveEnd.month - 1, inclusiveEnd.day + 1),
  )
  const fromUtc = localMidnightUtc(start.year, start.month, start.day, timeZone)
  const toUtc = localMidnightUtc(
    followingEnd.getUTCFullYear(),
    followingEnd.getUTCMonth() + 1,
    followingEnd.getUTCDate(),
    timeZone,
  )
  if (fromUtc >= toUtc) throw new RangeError('El rango de fechas es inválido.')
  return { from: fromUtc.toISOString(), to: toUtc.toISOString() }
}

export function dayRangeInTimeZone(now: Date, timeZone: string) {
  const localDate = dateInTimeZone(now, timeZone)
  return dateRangeForLocalDates(localDate, localDate, timeZone)
}
