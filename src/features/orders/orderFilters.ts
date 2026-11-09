import {
  addLocalDateDays,
  dateInTimeZone,
  dateRangeForLocalDates,
  firstDayOfLocalMonth,
  startOfLocalWeek,
} from '../../lib/timezone'
import type { AdminOrderRow } from './orderSchemas'

export type OrderDatePreset = 'today' | 'yesterday' | 'week' | 'last15' | 'month'

export const orderDatePresetLabels: ReadonlyArray<{ value: OrderDatePreset; label: string }> = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: 'week', label: 'Esta semana' },
  { value: 'last15', label: 'Últimos 15 días' },
  { value: 'month', label: 'Este mes' },
]

export type OrderListFilters = {
  search: string
  status: '' | AdminOrderRow['status']
  fulfillment: '' | AdminOrderRow['fulfillment_type']
  from: string
  to: string
  page: number
}

const orderStatuses = new Set<AdminOrderRow['status']>([
  'generated', 'whatsapp_opened', 'accepted', 'completed', 'cancelled', 'expired',
])
const fulfillmentTypes = new Set<AdminOrderRow['fulfillment_type']>(['delivery', 'pickup'])

export function orderDatePresets(now: Date, timeZone: string): Record<OrderDatePreset, { from: string; to: string }> {
  const today = dateInTimeZone(now, timeZone)
  const yesterday = addLocalDateDays(today, -1)
  return {
    today: { from: today, to: today },
    yesterday: { from: yesterday, to: yesterday },
    week: { from: startOfLocalWeek(today), to: today },
    last15: { from: addLocalDateDays(today, -14), to: today },
    month: { from: firstDayOfLocalMonth(today), to: today },
  }
}

export function activeOrderDatePreset(
  from: string,
  to: string,
  presets: Record<OrderDatePreset, { from: string; to: string }>,
): OrderDatePreset | 'custom' {
  return orderDatePresetLabels.find(({ value }) => presets[value].from === from && presets[value].to === to)?.value ?? 'custom'
}

function validDateRange(from: string | null, to: string | null): from is string {
  if (!from || !to) return false
  try {
    dateRangeForLocalDates(from, to, 'UTC')
    return true
  } catch {
    return false
  }
}

/** Parses and canonicalizes the supported query-string interface for the order list. */
export function parseOrderListFilters(params: URLSearchParams, today: string): {
  filters: OrderListFilters
  canonical: URLSearchParams
} {
  const rawStatus = params.get('status')
  const status = rawStatus && orderStatuses.has(rawStatus as AdminOrderRow['status'])
    ? rawStatus as AdminOrderRow['status']
    : ''
  const rawFulfillment = params.get('fulfillment')
  const fulfillment = rawFulfillment && fulfillmentTypes.has(rawFulfillment as AdminOrderRow['fulfillment_type'])
    ? rawFulfillment as AdminOrderRow['fulfillment_type']
    : ''
  const requestedPage = Number(params.get('page') ?? '1')
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage - 1 : 0
  const requestedFrom = params.get('from')
  const requestedTo = params.get('to')
  const validRange = validDateRange(requestedFrom, requestedTo)
  const from = validRange ? requestedFrom : today
  const to = validRange ? requestedTo! : today
  const search = (params.get('q') ?? '').slice(0, 120)

  const canonical = new URLSearchParams()
  if (search) canonical.set('q', search)
  if (status) canonical.set('status', status)
  if (fulfillment) canonical.set('fulfillment', fulfillment)
  canonical.set('from', from)
  canonical.set('to', to)
  if (page > 0) canonical.set('page', String(page + 1))

  return { filters: { search, status, fulfillment, from, to, page }, canonical }
}
