import type { OrderStatus, PublicPaymentMethod } from '../types/domain'
import { roundBasisPoints } from './money'

export const orderTransitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  generated: ['whatsapp_opened', 'accepted', 'cancelled', 'expired'],
  whatsapp_opened: ['accepted', 'cancelled', 'expired'],
  accepted: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  expired: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus) {
  return orderTransitions[from].includes(to)
}

export function estimateAdjustment(
  method: PublicPaymentMethod,
  subtotalCents: number,
  shippingCents: number,
) {
  if (method.adjustmentType === 'none') return 0
  const base =
    method.adjustmentScope === 'shipping'
      ? shippingCents
      : method.adjustmentScope === 'total'
        ? subtotalCents + shippingCents
        : subtotalCents
  const raw =
    roundBasisPoints(base, method.adjustmentBps) +
    method.adjustmentFixedCents
  return method.adjustmentType === 'discount' ? -Math.min(raw, base) : raw
}

export type OrderSearchFilter = {
  field: 'customer_phone' | 'display_number' | 'customer_name'
  value: string
}

export function orderSearchFilter(rawTerm: string): OrderSearchFilter | null {
  const term = rawTerm.trim()
  if (!term) return null
  const escaped = term.replace(/[%_]/g, '')
  if (/^\+?[\d\s()-]+$/.test(term)) {
    return { field: 'customer_phone', value: escaped }
  }
  const displayNumber = escaped.replace(/^#/, '')
  if (
    (escaped.startsWith('#') || /\d/.test(displayNumber)) &&
    /^[A-Z0-9-]+$/i.test(displayNumber)
  ) {
    return { field: 'display_number', value: displayNumber }
  }
  return { field: 'customer_name', value: escaped }
}
