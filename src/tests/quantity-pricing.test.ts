import { describe, expect, it } from 'vitest'
import {
  addOrMergeCartLine,
  normalizeCartLines,
  parseStoredCart,
  reconcileCartLines,
} from '../features/cart/CartProvider'
import {
  calculateQuantityPricing,
  cartLineConfigurationKey,
  effectiveQuantityPrices,
} from '../lib/quantity-pricing'
import type { CartLine, PublicProduct } from '../types/domain'

const baseLine: CartLine = {
  key: '10000000-0000-4000-8000-000000000001',
  productId: '20000000-0000-4000-8000-000000000001',
  productName: 'Empanada',
  productImagePath: null,
  quantity: 1,
  notes: '',
  unitPriceCents: 10_000,
  quantityPrices: [{ quantity: 2, totalPriceCents: 18_000 }],
  selectedOptions: [],
}

describe('quantity pricing', () => {
  it.each([
    [1, 10_000],
    [2, 18_000],
    [3, 28_000],
    [4, 36_000],
  ])('uses reusable bundles for %i units', (quantity, expected) => {
    expect(calculateQuantityPricing({
      quantity,
      unitPriceCents: 10_000,
      quantityPrices: [{ quantity: 2, totalPriceCents: 18_000 }],
    }).productSubtotalCents).toBe(expected)
  })

  it('finds the cheapest exact combination among competing bundles', () => {
    const price = calculateQuantityPricing({
      quantity: 6,
      unitPriceCents: 10_000,
      quantityPrices: [
        { quantity: 2, totalPriceCents: 19_000 },
        { quantity: 3, totalPriceCents: 25_000 },
        { quantity: 4, totalPriceCents: 37_000 },
      ],
    })

    expect(price.productSubtotalCents).toBe(50_000)
    expect(price.appliedQuantityPrices).toEqual([
      { quantity: 3, totalPriceCents: 25_000, uses: 2 },
    ])
  })

  it('charges selected additions per unit and outside quantity discounts', () => {
    expect(calculateQuantityPricing({
      quantity: 4,
      unitPriceCents: 10_000,
      quantityPrices: [{ quantity: 2, totalPriceCents: 18_000 }],
      optionUnitCents: 1_500,
    })).toMatchObject({
      productSubtotalCents: 36_000,
      optionsSubtotalCents: 6_000,
      totalCents: 42_000,
    })
  })

  it('keeps the unit price when a configured bundle is more expensive', () => {
    expect(calculateQuantityPricing({
      quantity: 2,
      unitPriceCents: 10_000,
      quantityPrices: [{ quantity: 2, totalPriceCents: 25_000 }],
    }).productSubtotalCents).toBe(20_000)
  })

  it('only advertises rules that remain effective at the current unit price', () => {
    const rules = [
      { quantity: 2, totalPriceCents: 18_000 },
      { quantity: 4, totalPriceCents: 38_000 },
    ]

    expect(effectiveQuantityPrices(10_000, rules)).toEqual([
      { quantity: 2, totalPriceCents: 18_000 },
    ])
    expect(effectiveQuantityPrices(8_000, rules)).toEqual([])
  })

  it('rejects duplicate or out-of-range rules', () => {
    expect(() => calculateQuantityPricing({
      quantity: 2,
      unitPriceCents: 10_000,
      quantityPrices: [
        { quantity: 2, totalPriceCents: 18_000 },
        { quantity: 2, totalPriceCents: 17_000 },
      ],
    })).toThrow(/repetidas/)
    expect(() => calculateQuantityPricing({
      quantity: 2,
      unitPriceCents: 10_000,
      quantityPrices: [{ quantity: 1, totalPriceCents: 9_000 }],
    })).toThrow(/entre 2 y 20/)
  })
})

describe('cart line merging', () => {
  it('restores legacy cart lines with no quantity rules', () => {
    const { quantityPrices: _omitted, ...legacyLine } = baseLine
    expect(parseStoredCart(JSON.stringify([legacyLine]))[0]?.quantityPrices).toEqual([])
  })

  it('coalesces fragmented and legacy identical lines independently of add order', () => {
    const fragmented = normalizeCartLines([
      { ...baseLine, quantity: 20 },
      { ...baseLine, key: crypto.randomUUID(), quantity: 1 },
      { ...baseLine, key: crypto.randomUUID(), quantity: 1 },
    ])
    expect(fragmented).toHaveLength(1)
    expect(fragmented[0]?.quantity).toBe(22)
    expect(calculateQuantityPricing({
      quantity: fragmented[0]!.quantity,
      unitPriceCents: fragmented[0]!.unitPriceCents,
      quantityPrices: fragmented[0]!.quantityPrices,
    }).productSubtotalCents).toBe(198_000)

    const { quantityPrices: _omitted, ...legacy } = baseLine
    const restored = parseStoredCart(JSON.stringify([
      legacy,
      { ...legacy, key: crypto.randomUUID() },
    ]))
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ quantity: 2, quantityPrices: [] })
  })

  it('rehydrates legacy pricing from the current public menu before estimating', () => {
    const { quantityPrices: _omitted, ...legacy } = baseLine
    const product: PublicProduct = {
      id: baseLine.productId,
      categoryId: '40000000-0000-4000-8000-000000000001',
      code: 'EMP',
      name: 'Empanada actualizada',
      description: '',
      basePriceCents: 10_000,
      promotionalPriceCents: null,
      promotionStartsAt: null,
      promotionEndsAt: null,
      imagePath: null,
      available: true,
      featured: false,
      sortOrder: 0,
      quantityPrices: [{ quantity: 2, totalPriceCents: 18_000 }],
      optionGroups: [],
    }

    const reconciled = reconcileCartLines(parseStoredCart(JSON.stringify([
      legacy,
      { ...legacy, key: crypto.randomUUID() },
    ])), [product])
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]).toMatchObject({
      productName: 'Empanada actualizada',
      quantity: 2,
      quantityPrices: [{ quantity: 2, totalPriceCents: 18_000 }],
    })
  })

  it('merges the same product, options and normalized notes into one canonical line', () => {
    const existing = {
      ...baseLine,
      selectedOptions: [{
        id: '30000000-0000-4000-8000-000000000001',
        groupName: 'Sabor',
        name: 'Carne',
        priceDeltaCents: 0,
      }],
    }
    const incoming = {
      ...existing,
      key: '10000000-0000-4000-8000-000000000002',
      quantity: 2,
      notes: '  ',
      unitPriceCents: 11_000,
    }

    const result = addOrMergeCartLine([existing], incoming)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ quantity: 3, unitPriceCents: 11_000, notes: '' })
  })

  it('does not merge different varieties or notes', () => {
    const otherOption = {
      ...baseLine,
      key: '10000000-0000-4000-8000-000000000002',
      selectedOptions: [{
        id: '30000000-0000-4000-8000-000000000002',
        groupName: 'Sabor',
        name: 'Jamón y queso',
        priceDeltaCents: 0,
      }],
    }
    expect(addOrMergeCartLine([baseLine], otherOption)).toHaveLength(2)
    expect(addOrMergeCartLine([baseLine], { ...baseLine, key: crypto.randomUUID(), notes: 'Sin sal' })).toHaveLength(2)
  })

  it('treats option order as irrelevant to the configuration key', () => {
    const first = { ...baseLine, selectedOptions: [
      { id: '30000000-0000-4000-8000-000000000001', groupName: 'A', name: 'A', priceDeltaCents: 0 },
      { id: '30000000-0000-4000-8000-000000000002', groupName: 'B', name: 'B', priceDeltaCents: 0 },
    ] }
    expect(cartLineConfigurationKey(first)).toBe(cartLineConfigurationKey({
      ...first,
      selectedOptions: [...first.selectedOptions].reverse(),
    }))
  })
})
