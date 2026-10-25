import { z } from 'zod'

const option = z.object({ id: z.string().uuid(), name: z.string(), price: z.string(), sortOrder: z.number(), active: z.boolean() })
export const productDraftSchema = z.object({
  id: z.string().uuid(), categoryId: z.string().uuid(), code: z.string(), name: z.string(), description: z.string(),
  basePrice: z.string(), promotionalPrice: z.string(), promotionStartsAt: z.string(), promotionEndsAt: z.string(),
  imagePath: z.string().nullable(), active: z.boolean(), available: z.boolean(), featured: z.boolean(), sortOrder: z.number(),
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
