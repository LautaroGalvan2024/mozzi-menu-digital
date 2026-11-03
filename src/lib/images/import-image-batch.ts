import { z } from 'zod'
import type { ImportImageAttempt } from '../import-session'
import { supabase } from '../supabase/client'
import { archiveImageFile, type ImageArchive, type ImageCatalogProduct } from './image-archive'
import { processImage } from './processImage'
import { uploadRestaurantImage } from './upload'

export interface ImageUploadTarget { key: string; productId: string; filename: string; expectedPath?: string | null }
export interface ImageUploadFailure { filename: string; message: string }
export interface ImageUploadProgress { current: number; total: number; label: string }

const productSchema = z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), image_path: z.string().nullable() })
export async function loadImageProducts(restaurantId: string, signal?: AbortSignal): Promise<ImageCatalogProduct[]> {
  const products: ImageCatalogProduct[] = []
  let after: string | undefined
  while (true) {
    signal?.throwIfAborted()
    let query = supabase.from('products').select('id,code,name,image_path').eq('restaurant_id', restaurantId).is('deleted_at', null).order('id').limit(500)
    if (after) query = query.gt('id', after)
    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query
    if (error) throw new Error('No pudimos consultar los productos del comercio. Volvé a intentar.')
    const page = z.array(productSchema).parse(data)
    products.push(...page)
    if (!page.length) return products
    const next = page.at(-1)!.id
    if (after && next <= after) throw new Error('La lista de productos cambió durante la lectura. Volvé a intentar.')
    after = next
  }
}

export async function uploadImageBatch(options: {
  restaurantId: string
  archive: ImageArchive
  targets: ImageUploadTarget[]
  attempts: Record<string, ImportImageAttempt>
  persist: () => Promise<unknown>
  onProgress?: (progress: ImageUploadProgress) => void
  isCurrent?: () => boolean
}): Promise<ImageUploadFailure[]> {
  const { restaurantId, archive, attempts, persist } = options
  const targets = options.targets.filter(target => !attempts[target.key]?.associated)
  if (!targets.length) return []
  const failures: ImageUploadFailure[] = []
  const currentPaths = new Map<string, string | null>()
  const ids = [...new Set(targets.map(target => target.productId))]
  for (let index = 0; index < ids.length; index += 100) {
    const response = await supabase.from('products').select('id,image_path').in('id', ids.slice(index, index + 100)).eq('restaurant_id', restaurantId).is('deleted_at', null)
    if (response.error) throw new Error('No se pudieron consultar las imágenes actuales; no se subió ningún archivo. Podés reintentar sin repetir los productos.')
    for (const product of response.data ?? []) currentPaths.set(product.id, product.image_path)
  }
  for (const [index, target] of targets.entries()) {
    if (options.isCurrent && !options.isCurrent()) break
    options.onProgress?.({ current: index + 1, total: targets.length, label: target.filename })
    try {
      let attempt = attempts[target.key]
      const currentPath = currentPaths.get(target.productId)
      if (currentPath === undefined) throw new Error('El producto no está disponible en este comercio. Volvé a revisar la asignación.')
      if (attempt?.path === currentPath) {
        attempt.associated = true
        await persist()
        continue
      }
      const expectedPath = attempt ? attempt.expectedPath : target.expectedPath
      if (expectedPath !== undefined && expectedPath !== currentPath) throw new Error('La imagen cambió después de la revisión. No se reemplazó; revisá la ficha del producto.')
      if (!attempt) {
        const file = await archiveImageFile(archive, target.filename)
        const image = await processImage(file)
        if (options.isCurrent && !options.isCurrent()) break
        const path = await uploadRestaurantImage({ restaurantId, kind: 'products', entityId: target.productId, image })
        attempt = { path, expectedPath: currentPath, associated: false }
        attempts[target.key] = attempt
        // Persist before association. A lost database reply can then be reconciled.
        await persist()
      }
      if (options.isCurrent && !options.isCurrent()) break
      let update = supabase.from('products').update({ image_path: attempt.path }).eq('id', target.productId).eq('restaurant_id', restaurantId).is('deleted_at', null)
      update = attempt.expectedPath === null ? update.is('image_path', null) : update.eq('image_path', attempt.expectedPath)
      const { data, error } = await update.select('id').maybeSingle()
      if (error || !data) {
        const check = await supabase.from('products').select('image_path').eq('id', target.productId).eq('restaurant_id', restaurantId).is('deleted_at', null).single()
        if (check.error || check.data.image_path !== attempt.path) throw new Error('No pudimos confirmar la asociación. Conservamos el intento para revisar o reintentar sin repetir la subida.')
      }
      attempt.associated = true
      currentPaths.set(target.productId, attempt.path)
      await persist()
      // Retain old/uncertain assets: deleting them requires authoritative reference checks.
    } catch (error) {
      failures.push({ filename: target.filename, message: error instanceof Error ? error.message : 'No pudimos cargar esta imagen.' })
    }
  }
  return failures
}
