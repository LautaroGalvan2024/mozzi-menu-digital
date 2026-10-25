import { beforeEach, describe, expect, it } from 'vitest'
import { inventoryOrderError, loadReverseAttempt, orderCommercialReport, saveReverseAttempt } from './inventoryOrder'
import { orderMetricsSchema } from './orderMetrics'
import type { AdminOrderRow } from './orderSchemas'

const root = '10000000-0000-4000-8000-000000000001'
const replacementId = '10000000-0000-4000-8000-000000000002'
const base = { id: root, display_number: 'PED-1', created_at: '2026-10-24T10:00:00Z', status: 'completed', inventory_outcome: 'delivered', root_order_id: null, replaces_order_id: null, replacement_reason: null, customer_name: 'Cliente', customer_phone: '1234', fulfillment_type: 'pickup', payment_method_name_snapshot: 'Efectivo', total_cents: '10000', accepted_at: '2026-10-24T10:00:00Z', completed_at: '2026-10-24T10:30:00Z' } as AdminOrderRow

describe('inventory and commercial order reporting', () => {
  beforeEach(() => localStorage.clear())
  it('keeps the historical amount but counts the replacement only once', () => {
    const rows = [
      orderCommercialReport({ ...base, inventory_outcome: 'corrected' }),
      orderCommercialReport({ ...base, id: replacementId, root_order_id: root, replaces_order_id: root, total_cents: '12000' }),
    ]
    expect(rows.map((row) => row.original_total_cents)).toEqual(['10000', '12000'])
    expect(rows.reduce((sum, row) => sum + Number(row.valid_commercial_amount_cents), 0)).toBe(12000)
    expect(rows.reduce((sum, row) => sum + Number(row.valid_delivered_amount_cents), 0)).toBe(12000)
    expect(new Set(rows.map((row) => row.root_order_id)).size).toBe(1)
    expect(rows[1]?.replaces_order_id).toBe(root)
  })
  it('returned deliveries and pending replacements do not become current sales', () => {
    expect(orderCommercialReport({ ...base, inventory_outcome: 'returned' }).valid_delivered_amount_cents).toBe(0)
    expect(orderCommercialReport({ ...base, status: 'generated', id: replacementId, root_order_id: root, replaces_order_id: root }).valid_commercial_amount_cents).toBe(0)
  })
  it('keeps commercial cases, physical handoffs, received returns and sellable returns separate', () => {
    const metrics = orderMetricsSchema.parse({ generated: 2, whatsappOpened: 2, accepted: 2, completed: 1, cancelled: 0, expired: 0, corrected: 0, returned: 1, acceptedAmountCents: '12000', completedAmountCents: '12000', byFulfillment: { pickup: 2 }, byPaymentMethod: [{ name: 'Efectivo', count: 1, amountCents: '12000' }], validDeliveredByCompletionDate: 1, validDeliveredCommercialCases: 1, physicalDispatches: 2, receivedReturnUnits: '3', sellableRestockedReturnUnits: '1' })
    expect(metrics.completed).toBe(1)
    expect(metrics.byPaymentMethod[0]?.amountCents).toBe(12000)
    expect(metrics.validDeliveredCommercialCases).toBe(1)
    expect(metrics.physicalDispatches).toBe(2)
    expect(metrics.receivedReturnUnits).toBe('3')
    expect(metrics.sellableRestockedReturnUnits).toBe('1')
  })
  it('persists the exact reversal payload for reload and never exposes internal SQL details', () => {
    const attempt = { operationId: replacementId, kind: 'return' as const, restock: true, reason: 'Envase roto', quantities: [{ productId: root, quantity: 1 }] }
    saveReverseAttempt(root, attempt)
    expect(loadReverseAttempt(root)).toEqual(attempt)
    expect(inventoryOrderError({ message: 'INVENTORY_RETURN_QUANTITIES_INVALID private detail' })).not.toContain('private')
    expect(inventoryOrderError({ message: 'secret.internal.table' })).not.toContain('secret')
  })
})
