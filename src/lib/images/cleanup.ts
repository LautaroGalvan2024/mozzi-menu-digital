import { z } from 'zod'
import { supabase } from '../supabase/client'

const cleanupPreparation = z.object({
  retained: z.boolean(),
  paths: z.array(z.string().min(1).max(500)).max(1000),
}).strict()

export type ImageCleanupResult = 'removed' | 'retained' | 'pending'

/** Business references must be detached first. Uncertainty always retains bytes. */
export async function cleanupRestaurantImage(restaurantId: string, path: string): Promise<ImageCleanupResult> {
  try {
    const { data, error } = await supabase.rpc('prepare_image_asset_cleanup', {
      p_restaurant_id: restaurantId,
      p_path: path,
    })
    if (error) return 'pending'
    const prepared = cleanupPreparation.safeParse(data)
    if (!prepared.success) return 'pending'
    if (prepared.data.retained) return 'retained'
    const paths = prepared.data.paths
    if (!paths.every(candidate => candidate.startsWith(`restaurants/${restaurantId}/`))) return 'pending'
    if (!paths.length) return 'removed'

    // The preparation is durable: new references cannot race this Storage call.
    // Registry rows remain pending when Storage fails, allowing a later retry.
    const removed = await supabase.storage.from('restaurant-assets').remove(paths)
    if (removed.error || !Array.isArray(removed.data)) return 'pending'
    const names = new Set(removed.data.map(object => object.name))
    return paths.every(candidate => names.has(candidate)) ? 'removed' : 'pending'
  } catch {
    return 'pending'
  }
}
