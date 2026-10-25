// Catalogue prices must be explicit: never guess a thousands separator or round
// extra decimals from an Excel numeric cell. Build cents from decimal digits.
export function parsePriceCents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const raw = String(value).trim()
  if (!/^(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2})$/.test(raw)) return null
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw
  const [whole = '', fraction = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000_000_000 ? amount : null
}

export function toCents(value: string | number): number {
  const normalized =
    typeof value === 'number'
      ? value
      : Number(value.replace(/\s/g, '').replace(',', '.'))
  if (!Number.isFinite(normalized)) throw new Error('Importe inválido')
  return Math.round(normalized * 100)
}

export function cents(value: number | string): number {
  const result = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(result)) {
    throw new Error('El importe excede el rango seguro del navegador')
  }
  return result
}

export function formatMoney(
  amountCents: number | string,
  currencyCode = 'ARS',
  locale = 'es-AR',
) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(cents(amountCents) / 100)
}

export function roundBasisPoints(amountCents: number, basisPoints: number) {
  return Math.round((amountCents * basisPoints) / 10_000)
}

export function currentProductPrice(
  product: {
    basePriceCents: number
    promotionalPriceCents: number | null
    promotionStartsAt: string | null
    promotionEndsAt: string | null
  },
  now = new Date(),
) {
  if (product.promotionalPriceCents === null) return product.basePriceCents
  const started =
    product.promotionStartsAt === null ||
    new Date(product.promotionStartsAt).getTime() <= now.getTime()
  const notEnded =
    product.promotionEndsAt === null ||
    new Date(product.promotionEndsAt).getTime() > now.getTime()
  return started && notEnded
    ? product.promotionalPriceCents
    : product.basePriceCents
}
