import { z } from 'zod'

const quantity = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform(String)
export const stockBalanceSchema = z.object({
  productId: z.string().uuid(), initialized: z.boolean(), onHand: quantity.nullable(), reserved: quantity.nullable(),
  available: quantity.nullable(), version: quantity.nullable(),
})
export type CatalogStockBalance = z.infer<typeof stockBalanceSchema>
export const catalogStockSchema = z.object({
  policy: z.object({ mode: z.enum(['never_enabled', 'enforced', 'paused']), version: quantity, cutoverId: z.string().uuid().nullable(), businessConfirmed: z.boolean(), businessPolicy: z.record(z.string(), z.unknown()).nullable() }),
  items: z.array(stockBalanceSchema),
})

export function parseStockQuantity(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (!/^\d{1,13}$/.test(value)) throw new Error('El stock debe ser una cantidad entera entre 0 y 9999999999999 unidades.')
  return BigInt(value).toString()
}

export function isDefinitiveCatalogError(error: unknown): boolean {
  const result = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error)
  return result.success && result.data.message !== 'IDEMPOTENCY_CONFLICT' && /^(22|23|40|42|P0)/.test(result.data.code ?? '')
}

export function catalogStockError(error: unknown): string {
  const result = z.object({ message: z.string() }).safeParse(error)
  const messages: Record<string, string> = {
    INVENTORY_VERSION_CONFLICT: 'El stock cambió mientras editabas. Revisá las cantidades actualizadas y volvé a ingresar el stock final que querés guardar.',
    INSUFFICIENT_STOCK: 'El stock final no puede ser menor que las unidades reservadas para pedidos. Revisá las cantidades actualizadas.',
    INVENTORY_PAUSED: 'El stock está pausado. Podés guardar los datos del producto sin modificar su stock.',
    INVENTORY_CUTOVER: 'Hay una actualización de inventario en curso. Podés guardar los datos del producto sin modificar su stock.',
    INVENTORY_NOT_INITIALIZED: 'Este producto todavía no tiene stock cargado. Ingresá la cantidad final, incluso si es cero.',
    INVENTORY_QUANTITY_INVALID: 'Ingresá una cantidad de stock entera y no negativa.',
    INVENTORY_PRODUCT_INVALID: 'No se encontró el producto en este comercio. Actualizá la pantalla.',
    INVENTORY_FORBIDDEN: 'No tenés permisos para modificar el stock de este comercio.',
    INVENTORY_VERSION_REQUIRED: 'Actualizá las cantidades antes de guardar el stock.',
    IDEMPOTENCY_CONFLICT: 'El guardado anterior todavía necesita confirmación. Reintentá el mismo envío antes de hacer otros cambios.',
  }
  if (result.success && messages[result.data.message]) return messages[result.data.message]!
  if (isDefinitiveCatalogError(error)) return 'No se guardaron los cambios. Revisá los datos y que el código no esté repetido.'
  return 'No se pudo confirmar el guardado. Reintentá el mismo envío: conservamos sus datos para no aplicar el stock dos veces.'
}
