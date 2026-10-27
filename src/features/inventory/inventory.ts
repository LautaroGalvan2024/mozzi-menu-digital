import { z } from 'zod'

const quantity = z.string().regex(/^\d+$/)
export const inventoryItemSchema = z.object({
  productId: z.string().uuid(), code: z.string(), name: z.string(), archived: z.boolean().default(false), initialized: z.boolean(),
  onHand: quantity.nullable(), reserved: quantity.nullable(), available: quantity.nullable(), version: quantity.nullable(),
})
export const inventorySchema = z.object({
  policy: z.object({
    mode: z.enum(['never_enabled', 'enforced', 'paused']), version: quantity,
    activatedAt: z.string().nullable(), pausedAt: z.string().nullable(),
    cutoverId: z.string().uuid().nullable(), countStartedAt: z.string().nullable(),
    businessConfirmed: z.boolean(), businessPolicy: z.record(z.string(), z.unknown()).nullable(),
  }),
  items: z.array(inventoryItemSchema), nextCursor: z.string().uuid().nullable(),
  operations: z.array(z.object({
    id: z.string().uuid(), kind: z.string(), orderId: z.string().uuid().nullable(), sourceOperationId: z.string().uuid().nullable(),
    reason: z.string(), externalReference: z.string().nullable().optional(), actorUserId: z.string().uuid().nullable(), actorName: z.string().nullable().optional(), createdAt: z.string(), result: z.unknown(),
    movements: z.array(z.object({ productId: z.string().uuid(), deltaOnHand: z.string(), deltaReserved: z.string(), returnedQuantity: quantity, onHandAfter: quantity, reservedAfter: quantity })).default([]),
  })),
})

export const operationLabels: Record<string, string> = {
  count: 'Conteo físico', reserve: 'Reserva', release: 'Liberación de reserva', delivery: 'Entrega',
  receipt: 'Ingreso', adjustment: 'Ajuste', external_sale: 'Venta externa', correction: 'Entrega corregida', return: 'Devolución',
  payment_hold: 'Reserva temporal de pago', payment_release: 'Liberación de pago pendiente',
}

export function inventoryError(error: unknown): string {
  const parsed = z.object({ message: z.string() }).safeParse(error)
  const messages: Record<string, string> = {
    INSUFFICIENT_STOCK: 'No alcanza el stock disponible. Revisá las reservas y las cantidades.',
    INVENTORY_PAUSED: 'El stock está pausado. Un administrador debe resolver la contingencia antes de continuar.',
    INVENTORY_CUTOVER: 'Hay un conteo físico en curso. Las operaciones están pausadas hasta finalizarlo.',
    INVENTORY_NOT_INITIALIZED: 'Este producto todavía no tiene un conteo inicial.',
    INVENTORY_RECONCILIATION_REQUIRED: 'Completá un conteo desde esta pausa antes de reanudar las operaciones.',
    INVENTORY_COUNT_INCOMPLETE: 'Faltan productos por contar. Incluí también los que tienen cantidad cero.',
    INVENTORY_COUNT_TIME_INVALID: 'El conteo debe hacerse dentro de la ventana actual. Revisá la hora del dispositivo y volvé a contar.',
    INVENTORY_COUNT_EVIDENCE_REQUIRED: 'Confirmá la ventana sin movimientos y dejá una observación del conteo.',
    INVENTORY_PENDING_REVIEW_REQUIRED: 'Revisá todos los pedidos pendientes antes de activar el stock.',
    INVENTORY_BUSINESS_POLICY_PENDING: 'Primero deben confirmarse las reglas comerciales del inventario.',
    INVENTORY_BUSINESS_POLICY_UNSUPPORTED: 'Estas reglas comerciales todavía no están cubiertas por esta versión.',
    INVENTORY_VERSION_CONFLICT: 'El saldo o el estado del inventario cambió desde que abriste la pantalla. Revisá los datos actualizados antes de volver a guardar.',
    INVENTORY_FORBIDDEN: 'No tenés permiso para realizar esta operación.',
    INVENTORY_QUANTITY_INVALID: 'Ingresá una cantidad entera válida.',
    INVENTORY_INPUT_INVALID: 'Revisá el motivo y los datos del movimiento.',
    INVENTORY_PRODUCT_INVALID: 'El producto ya no está disponible en este comercio. Actualizá la lista.',
    INVENTORY_DUPLICATE_PRODUCT: 'Cada producto debe aparecer una sola vez en el movimiento.',
    INVENTORY_VERSION_REQUIRED: 'Actualizá el saldo antes de registrar el movimiento.',
    INVENTORY_EXTERNAL_REFERENCE_REQUIRED: 'Indicá el canal y la referencia de la venta externa.',
    INVENTORY_EXTERNAL_REFERENCE_DUPLICATE: 'Esa venta externa ya fue registrada. Revisá los movimientos.',
    INVENTORY_EXTERNAL_ORDER_DUPLICATE: 'Ese pedido ya pertenece a la app. Registrá su entrega desde Pedidos.',
    INVENTORY_EXTERNAL_CHANNELS_DISABLED: 'Las ventas por otros canales no están habilitadas en las reglas del comercio.',
    INVENTORY_NOT_ENABLED: 'El stock todavía no está activo. Completá las reglas y el conteo inicial.',
    IDEMPOTENCY_CONFLICT: 'El intento anterior tiene otro contenido. Recuperá su resultado antes de continuar.',
  }
  return parsed.success && messages[parsed.data.message] ? messages[parsed.data.message]! : 'No se pudo confirmar la operación. Podés reintentar el mismo envío sin duplicar movimientos.'
}

export const countDraftSchema = z.record(z.string(), z.object({ quantity: z.string(), countedAt: z.string() }))
export type CountDraft = z.infer<typeof countDraftSchema>
export function countedQuantity(quantity: string) {
  return { quantity, countedAt: new Date().toISOString() }
}
export function readCountDraft(restaurantId: string, countId: string): CountDraft {
  try {
    const parsed = countDraftSchema.safeParse(JSON.parse(localStorage.getItem(`mozzi:inventory-count:${restaurantId}:${countId}`) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch { return {} }
}

export function countRows(items: z.infer<typeof inventoryItemSchema>[], counts: CountDraft) {
  return items.map(item => {
    const value = counts[item.productId]
    if (!value || !/^\d{1,13}$/.test(value.quantity)) throw new Error('Completá el conteo de todos los productos con cantidades enteras; usá cero cuando corresponda.')
    return { productId: item.productId, quantity: value.quantity, countedAt: value.countedAt }
  })
}
