import type { CartLine } from '../types/domain'

const ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000

type StoredAttempt = {
  fingerprint: string
  idempotencyKey: string
  createdAt: number
}

function storageKey(restaurantSlug: string) {
  return `mozzi:checkout-attempt:${restaurantSlug}`
}

function isStoredAttempt(value: unknown): value is StoredAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as Partial<StoredAttempt>
  return (
    typeof attempt.fingerprint === 'string' &&
    typeof attempt.idempotencyKey === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt.idempotencyKey) &&
    typeof attempt.createdAt === 'number' &&
    Number.isFinite(attempt.createdAt)
  )
}

export function checkoutCartFingerprint(lines: readonly CartLine[]) {
  return JSON.stringify(
    lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      notes: line.notes.trim(),
      optionIds: line.selectedOptions.map((option) => option.id),
    })),
  )
}

export function getCheckoutAttemptKey(
  restaurantSlug: string,
  fingerprint: string,
  now = Date.now(),
  createKey = () => crypto.randomUUID(),
) {
  try {
    const raw = sessionStorage.getItem(storageKey(restaurantSlug))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (
      isStoredAttempt(parsed) &&
      parsed.fingerprint === fingerprint &&
      now - parsed.createdAt >= 0 &&
      now - parsed.createdAt < ATTEMPT_TTL_MS
    ) {
      return parsed.idempotencyKey
    }
  } catch {
    // A disabled or full storage must not prevent checkout. The in-memory caller
    // still reuses the returned key during the mounted attempt.
  }

  const idempotencyKey = createKey()
  try {
    sessionStorage.setItem(
      storageKey(restaurantSlug),
      JSON.stringify({ fingerprint, idempotencyKey, createdAt: now }),
    )
  } catch {
    // Best-effort resilience across reloads; server-side idempotency remains authoritative.
  }
  return idempotencyKey
}

export function clearCheckoutAttempt(restaurantSlug: string) {
  try {
    sessionStorage.removeItem(storageKey(restaurantSlug))
  } catch {
    // Storage may be unavailable in privacy modes.
  }
}
