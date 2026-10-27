import { normalizePhone, whatsappUrl } from '../../lib/phone'
import type { AdminOrderRow } from './orderSchemas'

type ContactOrder = Pick<AdminOrderRow, 'customer_name' | 'customer_phone' | 'display_number' | 'status' | 'checkout_mode' | 'payment_status' | 'inventory_outcome'>

// Names enter a human-readable chat draft; strip control characters deliberately.
// eslint-disable-next-line no-control-regex
const singleLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()

export function orderContactPhone(raw: string): string | null {
  let compact = raw.normalize('NFKC').trim().replace(/[\s().-]/g, '')
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`
  if (!compact.startsWith('+')) compact = `+${compact}`
  // Validate before the shared normalizer, which intentionally strips non-digit formatting.
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null
  return normalizePhone(compact)
}

export function orderWhatsappContact(order: ContactOrder, businessName = '') {
  const phone = orderContactPhone(order.customer_phone)
  if (!phone) return null
  const customer = singleLine(order.customer_name)
  const business = singleLine(businessName)
  const number = singleLine(order.display_number)
  const greeting = customer ? `Hola, ${customer}.` : 'Hola.'
  const identity = business ? ` Somos ${business}.` : ''
  const reference = number ? `tu pedido ${number}` : 'tu pedido'
  const active = ['generated', 'whatsapp_opened', 'accepted'].includes(order.status)
    && !['corrected', 'returned', 'delivered'].includes(order.inventory_outcome)
  const preparing = active && (order.checkout_mode !== 'online' || order.payment_status === 'approved')
  const message = preparing
    ? `${greeting}${identity} Recibimos ${reference} y lo estamos preparando. ¡Gracias por tu compra!`
    : `${greeting}${identity} Te escribimos por ${reference}.`
  return { url: whatsappUrl(phone, message), message, preparing }
}
