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
