import { describe, expect, it } from 'vitest'
import { currentProductPrice, formatMoney, parsePriceCents, roundBasisPoints, toCents } from '../lib/money'
import { estimateAdjustment } from '../lib/orders'
import type { PublicPaymentMethod } from '../types/domain'

const method: PublicPaymentMethod = {
  id: '10000000-0000-4000-8000-000000000000', code: 'cash', name: 'Efectivo', description: '', adjustmentType: 'discount', adjustmentScope: 'subtotal', adjustmentBps: 1000, adjustmentFixedCents: 0, transferAlias: null, accountHolder: null, bankName: null, instructions: null, sortOrder: 0,
}

describe('money', () => {
  it('parses explicit catalogue amounts exactly without silently rounding or guessing separators', () => {
    for (const value of ['1234,56', '1234.56', '1.234,56', 1234.56]) expect(parsePriceCents(value)).toBe(123456)
    expect(parsePriceCents('0.29')).toBe(29)
    expect(parsePriceCents(10_000_000_000)).toBe(1_000_000_000_000)
    for (const value of ['1,234.56', '1.234', '1,234', '', '1e3', '0x10', '12 34', '1.234,567', 1.234, -1, Infinity, 10_000_000_001, null]) expect(parsePriceCents(value)).toBeNull()
  })
  it('converts decimal values to integer cents', () => {
    expect(toCents('1234,56')).toBe(123456)
  })
  it('rounds basis points consistently to the nearest cent', () => {
    expect(roundBasisPoints(10_005, 150)).toBe(150)
    expect(estimateAdjustment(method, 10_005, 0)).toBe(-1001)
  })
  it('applies fixed and percentage adjustments to the configured scope', () => {
    expect(estimateAdjustment({ ...method, adjustmentScope: 'shipping', adjustmentBps: 500, adjustmentFixedCents: 100 }, 10_000, 2_000)).toBe(-200)
    expect(estimateAdjustment({ ...method, adjustmentType: 'surcharge', adjustmentScope: 'total', adjustmentBps: 1_000 }, 8_000, 2_000)).toBe(1_000)
  })
  it('uses a promotion only inside its window', () => {
    const product = { basePriceCents: 5000, promotionalPriceCents: 4200, promotionStartsAt: '2026-01-01T00:00:00Z', promotionEndsAt: '2026-12-31T23:59:59Z' }
    expect(currentProductPrice(product, new Date('2026-06-01T00:00:00Z'))).toBe(4200)
    expect(currentProductPrice(product, new Date('2026-12-31T23:59:59Z'))).toBe(5000)
    expect(currentProductPrice(product, new Date('2027-01-01T00:00:00Z'))).toBe(5000)
  })
  it('formats currency without floating-point calculations', () => {
    expect(formatMoney(123456, 'ARS', 'es-AR')).toContain('1.234,56')
  })
})
