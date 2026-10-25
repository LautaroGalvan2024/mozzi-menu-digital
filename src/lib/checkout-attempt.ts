import type { CartLine } from '../types/domain'
import type { CheckoutValues } from './validation/schemas'

export type StoredCheckoutAttempt = {
  version?: 2
  fingerprint: string
  idempotencyKey: string
  createdAt: number
  status?: 'uncertain' | 'rejected'
  estimatedTotalCents?: number
}
const storageKey = (restaurantSlug: string) => `mozzi:checkout-attempt:${restaurantSlug}`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function readCheckoutAttempt(restaurantSlug: string): StoredCheckoutAttempt | null {
  let raw: string | null
  try { raw = sessionStorage.getItem(storageKey(restaurantSlug)) } catch { throw new Error('No podemos guardar el reintento en este navegador. Habilitá el almacenamiento antes de enviar el pedido.') }
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') throw new Error()
    const attempt = value as Partial<StoredCheckoutAttempt>
    if (typeof attempt.fingerprint !== 'string' || typeof attempt.idempotencyKey !== 'string' || !uuid.test(attempt.idempotencyKey) || typeof attempt.createdAt !== 'number' || !Number.isFinite(attempt.createdAt)) throw new Error()
    if (attempt.version !== undefined && (attempt.version !== 2 || !['uncertain', 'rejected'].includes(attempt.status ?? '') || !/^[a-f0-9]{64}$/.test(attempt.fingerprint))) throw new Error()
    if (attempt.estimatedTotalCents !== undefined && (!Number.isSafeInteger(attempt.estimatedTotalCents) || attempt.estimatedTotalCents < 0)) throw new Error()
    return attempt as StoredCheckoutAttempt
  } catch { throw new Error('No pudimos recuperar el intento anterior. Consultá al comercio antes de iniciar otro pedido.') }
}

export function checkoutCartFingerprint(lines: readonly CartLine[]) {
  const grouped = new Map<string, { productId: string; quantity: number; notes: string; optionIds: string[] }>()
  for (const line of lines) {
    const optionIds = [...new Set(line.selectedOptions.map((option) => option.id))].sort()
    const notes = normalizeMultiline(line.notes)
    const identity = JSON.stringify([line.productId, notes, optionIds])
    const previous = grouped.get(identity)
    grouped.set(identity, { productId: line.productId, quantity: (previous?.quantity ?? 0) + line.quantity, notes, optionIds })
  }
  return JSON.stringify([...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([, line]) => line))
}

function replaceControls(value: string, preserveNewlines = false): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0
    return (code <= 31 || code === 127) && !(preserveNewlines && code === 10) ? ' ' : character
  }).join('')
}
const normalizeSingleLine = (value = '') => replaceControls(value.normalize('NFKC')).replace(/\s+/g, ' ').trim()
const normalizeMultiline = (value = '') => replaceControls(value.normalize('NFKC').replace(/\r\n?/g, '\n'), true).split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()

export function checkoutBusinessRequest(slug: string, values: CheckoutValues, lines: readonly CartLine[]) {
  let phone = values.customerPhone.normalize('NFKC').trim().replace(/[\s().-]/g, '')
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`
  if (!phone.startsWith('+')) phone = `+${phone}`
  const items: { productId: string; quantity: number; notes: string; optionIds: string[] }[] = JSON.parse(checkoutCartFingerprint(lines))
  return {
    restaurantSlug: slug,
    customer: { name: normalizeSingleLine(values.customerName), phone },
    fulfillment: {
      type: values.fulfillmentType,
      ...(values.fulfillmentType === 'delivery' ? {
        deliveryZoneId: values.deliveryZoneId,
        address: normalizeSingleLine(values.address), city: normalizeSingleLine(values.city),
        neighborhood: normalizeSingleLine(values.neighborhood), floor: normalizeSingleLine(values.floor),
        apartment: normalizeSingleLine(values.apartment), reference: normalizeMultiline(values.reference),
      } : {}),
    },
    paymentMethodId: values.paymentMethodId,
    notes: normalizeMultiline(values.notes),
    items,
  }
}

export type CheckoutBusinessRequest = ReturnType<typeof checkoutBusinessRequest>

export async function checkoutRequestFingerprint(request: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function getCheckoutAttemptKey(restaurantSlug: string, fingerprint: string, now = Date.now(), createKey = () => crypto.randomUUID()) {
  const existing = readCheckoutAttempt(restaurantSlug)
  // Time and changes never rotate a key. Only confirmed success or an explicit
  // user decision after checking with the merchant may clear the old attempt.
  if (existing) return existing.idempotencyKey
  const idempotencyKey = createKey()
  try { sessionStorage.setItem(storageKey(restaurantSlug), JSON.stringify({ fingerprint, idempotencyKey, createdAt: now })) }
  catch { throw new Error('No pudimos guardar el reintento. El pedido no se envió; habilitá el almacenamiento y volvé a intentar.') }
  return idempotencyKey
}

export function recordCheckoutAttempt(restaurantSlug: string, key: string, fingerprint: string, status: 'uncertain' | 'rejected', estimatedTotalCents?: number): void {
  const existing = readCheckoutAttempt(restaurantSlug)
  if (existing && existing.idempotencyKey !== key) throw new Error('Otro intento reemplazó este pedido. Consultá al comercio antes de continuar.')
  const quote = estimatedTotalCents ?? existing?.estimatedTotalCents
  if (quote !== undefined && (!Number.isSafeInteger(quote) || quote < 0)) throw new Error('El total estimado no es válido. Revisá el carrito antes de enviar.')
  const attempt: StoredCheckoutAttempt = { version: 2, fingerprint, idempotencyKey: key, createdAt: existing?.createdAt ?? Date.now(), status, ...(quote !== undefined ? { estimatedTotalCents: quote } : {}) }
  try { sessionStorage.setItem(storageKey(restaurantSlug), JSON.stringify(attempt)) }
  catch { throw new Error('No pudimos guardar el reintento. El pedido no se envió; habilitá el almacenamiento y volvé a intentar.') }
}

export function clearCheckoutAttempt(restaurantSlug: string): void {
  sessionStorage.removeItem(storageKey(restaurantSlug))
}
