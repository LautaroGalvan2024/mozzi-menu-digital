import { z } from 'zod'
import { stockBalanceSchema } from './catalog-stock'

const option = z.object({ id: z.string().uuid(), name: z.string(), price: z.string(), sortOrder: z.number(), active: z.boolean() })
export const productDraftSchema = z.object({
  id: z.string().uuid(), categoryId: z.string().uuid(), code: z.string(), name: z.string(), description: z.string(),
  basePrice: z.string(), promotionalPrice: z.string(), promotionStartsAt: z.string(), promotionEndsAt: z.string(),
  imagePath: z.string().nullable(), active: z.boolean(), available: z.boolean(), featured: z.boolean(), sortOrder: z.number(),
  stockQuantity: z.string().default(''), stockBaseline: stockBalanceSchema.nullable().default(null),
  quantityPrices: z.array(z.object({ id: z.string().uuid(), quantity: z.number(), totalPrice: z.string() })),
  groups: z.array(z.object({ id: z.string().uuid(), name: z.string(), required: z.boolean(), minSelect: z.number(), maxSelect: z.number(), sortOrder: z.number(), active: z.boolean(), options: z.array(option) })),
})

export const pendingProductKey = (restaurantId: string) => `mozzi:product-attempt:${restaurantId}`

export function recoverProductDraft(restaurantId: string) {
  try {
    const value = sessionStorage.getItem(pendingProductKey(restaurantId))
    if (!value) return null
    const parsed = productDraftSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function saveProductAttempt(restaurantId: string, draft: z.infer<typeof productDraftSchema>) {
  // Persist before sending. A reload after a lost response reuses the same product UUID.
  sessionStorage.setItem(pendingProductKey(restaurantId), JSON.stringify(draft))
}

export function clearProductAttempt(restaurantId: string) {
  sessionStorage.removeItem(pendingProductKey(restaurantId))
}

const productSaveSchema = z.object({
  draft: productDraftSchema,
  previousImagePath: z.string().nullable(),
  request: z.object({
    p_restaurant_id: z.string().uuid(), p_operation_id: z.string().uuid(),
    p_product: z.object({ id: z.string().uuid() }).catchall(z.json()), p_groups: z.array(z.json()),
    p_removed_group_ids: z.array(z.string().uuid()), p_removed_option_ids: z.array(z.string().uuid()),
    p_stock: z.object({ onHand: z.string().regex(/^\d{1,13}$/), expectedVersion: z.string().regex(/^\d+$/).nullable() }).nullable(),
  }),
})
export type ProductSaveAttempt = z.infer<typeof productSaveSchema>
const productSaveKey = (restaurantId: string, productId?: string) => `mozzi:product-save:${restaurantId}:${productId ?? 'new'}`
export function recoverProductSave(restaurantId: string, productId?: string): ProductSaveAttempt | null {
  try {
    const result = productSaveSchema.safeParse(JSON.parse(localStorage.getItem(productSaveKey(restaurantId, productId)) ?? 'null'))
    if (!result.success || result.data.request.p_restaurant_id !== restaurantId || result.data.request.p_product.id !== result.data.draft.id || (productId && result.data.draft.id !== productId)) return null
    return result.data
  } catch { return null }
}
export function persistProductSave(restaurantId: string, productId: string | undefined, attempt: ProductSaveAttempt) {
  localStorage.setItem(productSaveKey(restaurantId, productId), JSON.stringify(attempt))
}
export function clearProductSave(restaurantId: string, productId?: string) {
  localStorage.removeItem(productSaveKey(restaurantId, productId))
}
