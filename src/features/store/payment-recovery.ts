import { z } from 'zod'
import { commerceStorageKey } from '../../lib/commerce-channel'

export const paymentStatusSchema = z.object({
  order: z.object({
    actionId: z.string().uuid(), displayNumber: z.string(), status: z.string(),
    totalCents: z.coerce.number().int().nonnegative().safe(), currencyCode: z.string().length(3), createdAt: z.string(),
    sellerName: z.string().optional(), estimatedDeliveryDate: z.iso.date().optional(),
  }),
  payment: z.object({
    status: z.string(),
    checkoutUrl: z.string().url().refine(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && ['www.mercadopago.com.ar', 'www.mercadopago.com', 'sandbox.mercadopago.com.ar', 'sandbox.mercadopago.com'].includes(url.hostname) && !url.username && !url.password
    }).nullable().optional(),
    expiresAt: z.string().nullable().optional(),
    requiresRefund: z.boolean().optional(),
    reviewRequired: z.boolean().optional(),
  }),
  recoveryExpiresAt: z.string().datetime({ offset: true }).optional(),
})
export const paymentSessionSchema = paymentStatusSchema.extend({
  recoveryToken: z.string().min(22).max(256).regex(/^[A-Za-z0-9_-]+$/),
  recoveryExpiresAt: z.string().datetime({ offset: true }),
})
const referenceSchema = z.object({ actionId: z.string().uuid(), token: z.string().min(22).max(256).regex(/^[A-Za-z0-9_-]+$/), expiresAt: z.string().datetime({ offset: true }) }).strict()
export type PaymentStatus = z.infer<typeof paymentStatusSchema>
const key = (slug: string) => commerceStorageKey('payment-confirmation', slug, 'store')
const orderKey = (slug: string, actionId: string) => `${key(slug)}:${actionId.toLowerCase()}`

function readReference(storageKey: string) {
  try {
    const result = referenceSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
    if (!result.success || Date.parse(result.data.expiresAt) <= Date.now()) return null
    return result.data
  } catch { return null }
}

export function savePaymentRecovery(slug: string, payment: z.infer<typeof paymentSessionSchema>) {
  try {
    // Preserve the previous client's single record before replacing its pointer.
    const previous = readReference(key(slug))
    if (previous) localStorage.setItem(orderKey(slug, previous.actionId), JSON.stringify(previous))
    const prefix = `${key(slug)}:`
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const candidate = localStorage.key(index)
      if (candidate?.startsWith(prefix) && !readReference(candidate)) localStorage.removeItem(candidate)
    }
    const reference = JSON.stringify({ actionId: payment.order.actionId, token: payment.recoveryToken, expiresAt: payment.recoveryExpiresAt })
    localStorage.setItem(orderKey(slug, payment.order.actionId), reference)
    // Older clients and URLs without ?order still recover the last purchase.
    localStorage.setItem(key(slug), reference)
    return true
  } catch { return false }
}

export function readPaymentRecovery(slug: string, actionId?: string | null) {
  if (actionId === undefined || actionId === null) return readReference(key(slug))
  if (!z.string().uuid().safeParse(actionId).success) return null
  const requested = actionId.toLowerCase()
  const scoped = readReference(orderKey(slug, requested))
  if (scoped?.actionId.toLowerCase() === requested) return scoped
  const legacy = readReference(key(slug))
  return legacy?.actionId.toLowerCase() === requested ? legacy : null
}
