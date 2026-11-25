import { z } from 'zod'
import { assetVariantPaths } from '../../lib/images/responsive'
import { supabase } from '../../lib/supabase/client'
import { publicAssetUrl } from '../../lib/supabase/public-assets'

const offerItem = z.object({
  id: z.uuid(),
  name: z.string(),
  image_path: z.string().nullable(),
  price: z.number().int().nonnegative(),
}).transform(({ image_path, ...item }) => {
  const thumbnailPath = image_path ? assetVariantPaths(image_path)[0] ?? image_path : null
  return {
    ...item,
    image_url: publicAssetUrl(thumbnailPath),
    ...(image_path && thumbnailPath !== image_path ? { original_url: publicAssetUrl(image_path) } : {}),
  }
})

const offerOrder = z.object({ revision: z.string().min(1), items: z.array(offerItem) })
export type StoreOfferOrder = z.infer<typeof offerOrder>
export type StoreOfferItem = z.infer<typeof offerItem>

export class OfferOrderConflictError extends Error {
  constructor() {
    super('Las ofertas cambiaron mientras las ordenabas.')
    this.name = 'OfferOrderConflictError'
  }
}

export class OfferOrderPermissionError extends Error {
  constructor() {
    super('Ya no tenés permiso para ordenar las ofertas de este comercio.')
    this.name = 'OfferOrderPermissionError'
  }
}

export async function getStoreOfferOrder(restaurantId: string): Promise<StoreOfferOrder> {
  const { data, error } = await supabase.rpc('get_store_offer_order', { p_restaurant_id: restaurantId })
  if (error?.code === '42501') throw new OfferOrderPermissionError()
  if (error) throw new Error('No pudimos cargar las ofertas. Volvé a intentar.')
  return offerOrder.parse(data)
}

export async function saveStoreOfferOrder(restaurantId: string, expectedRevision: string, groupIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('save_store_offer_order', {
    p_restaurant_id: restaurantId,
    p_expected_revision: expectedRevision,
    p_group_ids: groupIds,
  })
  if (!error) return
  if (error.code === 'PT409' && error.message === 'STORE_OFFER_ORDER_STALE') throw new OfferOrderConflictError()
  if (error.code === '42501') throw new OfferOrderPermissionError()
  throw new Error('No pudimos guardar el orden. Volvé a intentar.')
}
