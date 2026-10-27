import { z } from 'zod'
import { commerceStorageKey } from '../../lib/commerce-channel'

export const paymentStatusSchema = z.object({
  order: z.object({ actionId: z.string().uuid(), displayNumber: z.string(), status: z.string(), totalCents: z.coerce.number().int().nonnegative().safe(), currencyCode: z.string().length(3), createdAt: z.string() }),
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

export function savePaymentRecovery(slug: string, payment: z.infer<typeof paymentSessionSchema>) {
  try {
    localStorage.setItem(key(slug), JSON.stringify({ actionId: payment.order.actionId, token: payment.recoveryToken, expiresAt: payment.recoveryExpiresAt }))
    return true
  } catch { return false }
}

export function readPaymentRecovery(slug: string) {
  try {
    const result = referenceSchema.safeParse(JSON.parse(localStorage.getItem(key(slug)) ?? 'null'))
    if (!result.success || Date.parse(result.data.expiresAt) <= Date.now()) return null
    return result.data
  } catch { return null }
}
