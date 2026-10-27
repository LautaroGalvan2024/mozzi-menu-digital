import { z } from 'zod'
import type { GeneratedOrder } from '../types/domain'
import { commerceStorageKey, type CommerceChannel } from './commerce-channel'

const referenceSchema = z.object({
  actionId: z.string().uuid(),
  token: z.string().min(22).max(256).regex(/^[A-Za-z0-9_-]+$/),
  expiresAt: z.string().datetime({ offset: true }),
  estimatedTotalCents: z.number().int().nonnegative().safe().optional(),
}).strict()
export type OrderRecoveryReference = z.infer<typeof referenceSchema>
const key = (slug: string, channel: CommerceChannel = 'menu') => commerceStorageKey('order-confirmation', slug, channel)

// Store only the temporary read capability and a quoted amount. Personal data,
// order contents and the WhatsApp message never enter persistent browser storage.
export function saveOrderRecovery(slug: string, result: GeneratedOrder, channel: CommerceChannel = 'menu'): boolean {
  if (!result.recoveryToken || !result.recoveryExpiresAt) return false
  const parsed = referenceSchema.safeParse({ actionId: result.order.actionId, token: result.recoveryToken,
    expiresAt: result.recoveryExpiresAt, estimatedTotalCents: result.estimatedTotalCents })
  if (!parsed.success) return false
  try { localStorage.setItem(key(slug, channel), JSON.stringify(parsed.data)); return true } catch { return false }
}

export function readOrderRecovery(slug: string, now = Date.now(), channel: CommerceChannel = 'menu'): OrderRecoveryReference | null {
  try {
    const parsed = referenceSchema.safeParse(JSON.parse(localStorage.getItem(key(slug, channel)) ?? 'null'))
    if (!parsed.success) return null
    if (Date.parse(parsed.data.expiresAt) <= now) { localStorage.removeItem(key(slug, channel)); return null }
    return parsed.data
  } catch { return null }
}

export function forgetOrderRecovery(slug: string, channel: CommerceChannel = 'menu') {
  try { localStorage.removeItem(key(slug, channel)) } catch { /* The server still enforces expiry. */ }
}
