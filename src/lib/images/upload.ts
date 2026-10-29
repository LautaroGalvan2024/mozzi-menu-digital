import { supabase } from '../supabase/client'
import type { ProcessedImage } from './processImage'

export type AssetKind = 'logo' | 'cover' | 'categories' | 'products' | 'promotions'

export async function uploadRestaurantImage({ restaurantId, kind, entityId, image }: { restaurantId: string; kind: AssetKind; entityId?: string; image: ProcessedImage }) {
  const segment = entityId ? `${kind}/${entityId}` : kind
  const variants = image.variants?.length ? image.variants : [image]
  const uploadedPaths: string[] = []
  const entityType = {
    logo: 'restaurant_logo',
    cover: 'restaurant_cover',
    categories: 'category',
    products: 'product',
    promotions: 'promotion',
  }[kind]
  for (const variant of variants) {
    const path = `restaurants/${restaurantId}/${segment}/${variant.filename}`
    const { error: uploadError } = await supabase.storage.from('restaurant-assets').upload(path, variant.blob, {
      cacheControl: '31536000',
      contentType: variant.mimeType,
      upsert: false,
    })
    if (uploadError) {
      if (uploadedPaths.length) await supabase.storage.from('restaurant-assets').remove(uploadedPaths)
      throw new Error('No se pudo subir la imagen.')
    }
    uploadedPaths.push(path)
  }

  const { data: userData } = await supabase.auth.getUser()
  const actorId = userData.user?.id
  if (!actorId) {
    await supabase.storage.from('restaurant-assets').remove(uploadedPaths)
    throw new Error('La sesión expiró antes de registrar la imagen.')
  }
  const { error: assetError } = await supabase.from('image_assets').insert(variants.map((variant, index) => ({
    restaurant_id: restaurantId,
    entity_type: entityType,
    entity_id: entityId ?? null,
    bucket: 'restaurant-assets',
    path: uploadedPaths[index]!,
    mime_type: variant.mimeType,
    size_bytes: variant.blob.size,
    width: variant.width,
    height: variant.height,
    created_by: actorId,
  })))
  if (assetError) {
    await supabase.storage.from('restaurant-assets').remove(uploadedPaths)
    throw new Error('No se pudo registrar la imagen.')
  }
  return uploadedPaths.at(-1)!
}
