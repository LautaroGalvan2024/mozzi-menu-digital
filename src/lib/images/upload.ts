import { supabase } from '../supabase/client'
import type { ProcessedImage } from './processImage'

export type AssetKind = 'logo' | 'cover' | 'categories' | 'products' | 'promotions'

export async function uploadRestaurantImage({ restaurantId, kind, entityId, image }: { restaurantId: string; kind: AssetKind; entityId?: string; image: ProcessedImage }) {
  const segment = entityId ? `${kind}/${entityId}` : kind
  const path = `restaurants/${restaurantId}/${segment}/${image.filename}`
  const entityType = {
    logo: 'restaurant_logo',
    cover: 'restaurant_cover',
    categories: 'category',
    products: 'product',
    promotions: 'promotion',
  }[kind]
  const { error: uploadError } = await supabase.storage.from('restaurant-assets').upload(path, image.blob, {
    cacheControl: '31536000',
    contentType: image.mimeType,
    upsert: false,
  })
  if (uploadError) throw new Error('No se pudo subir la imagen.')

  const { data: userData } = await supabase.auth.getUser()
  const actorId = userData.user?.id
  if (!actorId) {
    await supabase.storage.from('restaurant-assets').remove([path])
    throw new Error('La sesión expiró antes de registrar la imagen.')
  }
  const { error: assetError } = await supabase.from('image_assets').insert({
    restaurant_id: restaurantId,
    entity_type: entityType,
    entity_id: entityId ?? null,
    bucket: 'restaurant-assets',
    path,
    mime_type: image.mimeType,
    size_bytes: image.blob.size,
    width: image.width,
    height: image.height,
    created_by: actorId,
  })
  if (assetError) {
    await supabase.storage.from('restaurant-assets').remove([path])
    throw new Error('No se pudo registrar la imagen.')
  }
  return path
}
