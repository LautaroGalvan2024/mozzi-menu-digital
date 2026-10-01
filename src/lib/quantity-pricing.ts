import type { CartLine, QuantityPrice } from '../types/domain'

export interface QuantityPricingBreakdown {
  productSubtotalCents: number
  optionsSubtotalCents: number
  totalCents: number
  appliedQuantityPrices: Array<QuantityPrice & { uses: number }>
}

interface PricingBundle extends QuantityPrice {
  isUnit: boolean
}

interface PriceStep {
  cost: number
  bundles: PricingBundle[]
}

function assertSafeMoney(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} debe ser un entero no negativo.`)
  }
}

/**
 * Finds the cheapest exact combination of unit prices and reusable quantity rules.
 * Option deltas deliberately stay outside bundles and are charged once per unit.
 */
export function calculateQuantityPricing({
  quantity,
  unitPriceCents,
  quantityPrices,
  optionUnitCents = 0,
}: {
  quantity: number
  unitPriceCents: number
  quantityPrices: readonly QuantityPrice[]
  optionUnitCents?: number
}): QuantityPricingBreakdown {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new RangeError('La cantidad debe ser un entero entre 1 y 100.')
  }
  assertSafeMoney(unitPriceCents, 'El precio unitario')
  assertSafeMoney(optionUnitCents, 'El adicional unitario')

  const bundles: PricingBundle[] = [{ quantity: 1, totalPriceCents: unitPriceCents, isUnit: true }]
  const seenQuantities = new Set<number>()
  for (const rule of quantityPrices) {
    if (!Number.isInteger(rule.quantity) || rule.quantity < 2 || rule.quantity > 20) {
      throw new RangeError('Las cantidades promocionales deben estar entre 2 y 20.')
    }
    assertSafeMoney(rule.totalPriceCents, 'El precio por cantidad')
    if (seenQuantities.has(rule.quantity)) {
      throw new RangeError('No puede haber cantidades promocionales repetidas.')
    }
    seenQuantities.add(rule.quantity)
    bundles.push({ ...rule, isUnit: false })
  }

  const steps: Array<PriceStep | undefined> = Array.from({ length: quantity + 1 })
  steps[0] = { cost: 0, bundles: [] }
  for (let current = 1; current <= quantity; current += 1) {
    for (const bundle of bundles) {
      const previous = steps[current - bundle.quantity]
      if (!previous) continue
      const cost = previous.cost + bundle.totalPriceCents
      assertSafeMoney(cost, 'El subtotal del producto')
      if (!steps[current] || cost < steps[current]!.cost) {
        steps[current] = { cost, bundles: [...previous.bundles, bundle] }
      }
    }
  }

  const best = steps[quantity]
  if (!best) throw new Error('No se pudo calcular una combinación exacta de precios.')
  const optionsSubtotalCents = optionUnitCents * quantity
  assertSafeMoney(optionsSubtotalCents, 'El subtotal de adicionales')
  const totalCents = best.cost + optionsSubtotalCents
  assertSafeMoney(totalCents, 'El total de la línea')

  const grouped = new Map<number, QuantityPrice & { uses: number }>()
  for (const bundle of best.bundles) {
    if (bundle.isUnit) continue
    const current = grouped.get(bundle.quantity)
    grouped.set(bundle.quantity, {
      quantity: bundle.quantity,
      totalPriceCents: bundle.totalPriceCents,
      uses: (current?.uses ?? 0) + 1,
    })
  }

  return {
    productSubtotalCents: best.cost,
    optionsSubtotalCents,
    totalCents,
    appliedQuantityPrices: [...grouped.values()].sort((left, right) => left.quantity - right.quantity),
  }
}

export function calculateCartLineTotal(line: CartLine) {
  return calculateQuantityPricing({
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    quantityPrices: line.quantityPrices,
    optionUnitCents: line.selectedOptions.reduce(
      (total, option) => total + option.priceDeltaCents,
      0,
    ),
  }).totalCents
}

/**
 * Only exposes rules that are a real saving at the current unit price and whose
 * advertised total is the canonical cheapest total for that exact quantity.
 * A scheduled product promotion can temporarily make an older bundle obsolete.
 */
export function effectiveQuantityPrices(
  unitPriceCents: number,
  quantityPrices: readonly QuantityPrice[],
) {
  return quantityPrices.filter((rule) => (
    rule.totalPriceCents < unitPriceCents * rule.quantity
    && calculateQuantityPricing({
      quantity: rule.quantity,
      unitPriceCents,
      quantityPrices,
    }).productSubtotalCents === rule.totalPriceCents
  ))
}

export function cartLineConfigurationKey(line: Pick<CartLine, 'productId' | 'notes' | 'selectedOptions'>) {
  return JSON.stringify({
    productId: line.productId,
    notes: line.notes.trim(),
    optionIds: line.selectedOptions.map((option) => option.id).sort(),
  })
}
