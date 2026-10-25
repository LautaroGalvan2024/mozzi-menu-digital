import { z } from 'zod'
import type { AdminOrderRow } from './orderSchemas'

export const inventoryOutcomeSchema = z.enum(['none', 'delivered', 'corrected', 'returned'])
// The RPC preserves either JSON integers or digit strings. Orders contain at
// most 100 units; validate the text before conversion so malformed values fail.
const restockQuantitySchema = z.union([
  z.number(),
  z.string().regex(/^\d{1,13}$/).transform(Number),
]).pipe(z.number().int().min(0).max(100))
export const inventoryDetailSchema = z.object({
  replacementOrderId: z.string().uuid().nullable(),
  inventoryOperations: z.array(z.object({ id: z.string().uuid(), kind: z.string(), reason: z.string().nullable(), createdAt: z.string(), actorUserId: z.string().uuid().nullable(), result: z.object({ restocked: z.boolean().optional(), restockQuantities: z.array(z.object({ productId: z.string().uuid(), quantity: restockQuantitySchema })).nullable().optional() }).passthrough() })),
})
export const inventoryOutcomeLabel = { none: 'Sin entrega registrada', delivered: 'Entrega vigente', corrected: 'Entrega corregida', returned: 'Devuelta' } as const
export function isReversed(order: Pick<AdminOrderRow, 'inventory_outcome'>): boolean {
  return order.inventory_outcome === 'corrected' || order.inventory_outcome === 'returned'
}
export function orderCommercialReport(order: AdminOrderRow) {
  const valid = ['accepted', 'completed'].includes(order.status) && !isReversed(order)
  return {
    order_id: order.id, display_number: order.display_number, created_at: order.created_at, status: order.status,
    inventory_outcome: order.inventory_outcome, root_order_id: order.root_order_id ?? order.id,
    replaces_order_id: order.replaces_order_id ?? '', replacement_reason: order.replacement_reason ?? '',
    customer_name: order.customer_name, customer_phone: order.customer_phone,
    fulfillment_type: order.fulfillment_type, payment_method_name_snapshot: order.payment_method_name_snapshot,
    original_total_cents: order.total_cents, valid_commercial_amount_cents: valid ? order.total_cents : 0,
    valid_delivered_amount_cents: valid && order.status === 'completed' ? order.total_cents : 0,
    accepted_at: order.accepted_at, completed_at: order.completed_at,
  }
}

const errors: Record<string, string> = {
  INVENTORY_INSUFFICIENT: 'No hay stock disponible suficiente. Revisá las existencias antes de aceptar el pedido.',
  INSUFFICIENT_STOCK: 'No hay stock disponible suficiente. Revisá las existencias antes de aceptar el pedido.',
  INVENTORY_NOT_INITIALIZED: 'Falta cargar el inventario de un producto. Pedile al administrador que complete el conteo.',
  INVENTORY_PAUSED: 'El inventario está pausado. El administrador debe revisar la situación antes de continuar.',
  INVENTORY_CUTOVER: 'Hay un conteo de inventario en curso. Esperá a que el administrador lo finalice.',
  INVENTORY_POLICY_MISMATCH: 'El pedido necesita revisión del inventario. No se modificó su estado.',
  INVENTORY_RESERVATION_MISSING: 'No se encontró la reserva del pedido. Pedile al administrador que la revise.',
  INVENTORY_ALREADY_REVERSED: 'La entrega ya fue corregida o devuelta. Actualizá el pedido para ver el resultado.',
  INVENTORY_DELIVERY_MISSING: 'No se encontró una entrega de inventario para corregir o devolver.',
  INVENTORY_REPLACEMENT_INVALID: 'El reemplazo debe ser un pedido pendiente del mismo comercio y no estar vinculado a otro pedido.',
  INVENTORY_RETURN_QUANTITIES_INVALID: 'Revisá cuántas unidades vendibles reponés de cada producto. No pueden superar la cantidad entregada.',
  INVENTORY_FORBIDDEN: 'No tenés permisos para realizar esta operación.',
  ORDER_NOT_FOUND_OR_FORBIDDEN: 'No se encontró el pedido o no tenés permisos para modificarlo.',
  IDEMPOTENCY_CONFLICT: 'Este intento ya se usó con otros datos. Recuperá el resultado anterior antes de continuar.',
}
export function inventoryOrderError(error: unknown): string {
  const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : ''
  return Object.entries(errors).find(([code]) => message.includes(code))?.[1] ?? 'No pudimos confirmar la operación. Actualizá el pedido o reintentá la misma acción; no se duplicarán los movimientos.'
}

export const reverseAttemptSchema = z.object({ operationId: z.string().uuid(), kind: z.enum(['correction', 'return']), restock: z.boolean(), reason: z.string().min(3).max(500), quantities: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().nonnegative() })).optional() })
export type ReverseAttempt = z.infer<typeof reverseAttemptSchema>
const reversalKey = (orderId: string) => `order-inventory-reversal:v1:${orderId}`
export function loadReverseAttempt(orderId: string): ReverseAttempt | null {
  const stored = localStorage.getItem(reversalKey(orderId))
  return stored ? reverseAttemptSchema.parse(JSON.parse(stored)) : null
}
export function saveReverseAttempt(orderId: string, attempt: ReverseAttempt): void {
  localStorage.setItem(reversalKey(orderId), JSON.stringify(attempt))
}
export function clearReverseAttempt(orderId: string): void { localStorage.removeItem(reversalKey(orderId)) }
