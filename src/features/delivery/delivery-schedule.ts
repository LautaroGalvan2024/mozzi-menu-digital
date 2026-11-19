import { z } from 'zod'

export const weekdays = [
  { value: 1, label: 'Lunes', short: 'Lun' },
  { value: 2, label: 'Martes', short: 'Mar' },
  { value: 3, label: 'Miércoles', short: 'Mié' },
  { value: 4, label: 'Jueves', short: 'Jue' },
  { value: 5, label: 'Viernes', short: 'Vie' },
  { value: 6, label: 'Sábado', short: 'Sáb' },
  { value: 0, label: 'Domingo', short: 'Dom' },
] as const

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const dateSchema = z.string().refine(isCalendarDate, 'Revisá la fecha de cierre.')
export const deliveryPolicyInputSchema = z.object({
  menuEnabled: z.boolean(),
  storeEnabled: z.boolean(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Elegí una hora de cierre válida.'),
  cutoffDayOffset: z.union([z.literal(0), z.literal(1)]),
  closedDates: z.array(dateSchema).max(60, 'Podés cargar hasta 60 fechas sin reparto.'),
}).refine(policy => !(policy.menuEnabled || policy.storeEnabled) || policy.weekdays.length > 0, {
  path: ['weekdays'], message: 'Elegí al menos un día de reparto.',
})

export type DeliveryPolicyInput = z.infer<typeof deliveryPolicyInputSchema>
export const deliveryPolicySchema = z.object({
  zoneId: z.string().uuid(),
  menuEnabled: z.boolean(), storeEnabled: z.boolean(),
  weekdays: z.array(z.number().int().min(0).max(6)),
  cutoffTime: z.string(), cutoffDayOffset: z.union([z.literal(0), z.literal(1)]),
  closedDates: z.array(dateSchema), revision: z.number().int().positive(), updatedAt: z.string(),
})
export type DeliverySchedulePolicy = z.infer<typeof deliveryPolicySchema>

export const emptyDeliveryPolicy = (): DeliveryPolicyInput => ({
  menuEnabled: false, storeEnabled: false, weekdays: [],
  cutoffTime: '18:00', cutoffDayOffset: 1, closedDates: [],
})

function addDays(value: string, count: number): string {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}

/** An editable policy's preview. PostgreSQL independently decides the saved order date. */
export class DeliverySchedule {
  private readonly policy: DeliveryPolicyInput

  constructor(input: DeliveryPolicyInput) {
    this.policy = deliveryPolicyInputSchema.parse(input)
  }

  toInput(): DeliveryPolicyInput {
    return { ...this.policy, weekdays: [...new Set(this.policy.weekdays)].sort(), closedDates: [...new Set(this.policy.closedDates)].sort() }
  }

  nextDate(now: Date, timezone: string): string | null {
    if (!this.policy.menuEnabled && !this.policy.storeEnabled) return null
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now)
    const part = (name: string) => parts.find(item => item.type === name)!.value
    const today = `${part('year')}-${part('month')}-${part('day')}`
    const localNow = `${today}T${part('hour')}:${part('minute')}:${part('second')}`
    for (let offset = 0; offset <= 366; offset += 1) {
      const candidate = addDays(today, offset)
      const weekday = new Date(`${candidate}T12:00:00Z`).getUTCDay()
      const cutoff = `${addDays(candidate, -this.policy.cutoffDayOffset)}T${this.policy.cutoffTime}:00`
      if (this.policy.weekdays.includes(weekday) && !this.policy.closedDates.includes(candidate) && localNow < cutoff) return candidate
    }
    return null
  }
}

/** A delivery date is a calendar date, not a UTC instant that may shift by timezone. */
export function formatDeliveryDate(date: string, locale = 'es-AR'): string {
  if (!isCalendarDate(date)) return 'a coordinar'
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`))
}
