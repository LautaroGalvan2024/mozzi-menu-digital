import { supabase } from '../../lib/supabase/client'
import { publicMenuSchema } from '../../lib/validation/schemas'
import type { PublicMenu } from '../../types/domain'

export async function fetchPublicMenu(slug: string): Promise<PublicMenu> {
  const { data, error } = await supabase.rpc('get_public_menu', {
    p_restaurant_slug: slug,
  })
  if (error) {
    if (error.code === 'PGRST116' || error.message.includes('not found')) {
      throw new Error('No encontramos un menú publicado con esa dirección.')
    }
    throw new Error('No pudimos cargar el menú. Volvé a intentar.')
  }
  const parsed = publicMenuSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error('El menú publicado tiene una configuración inválida. Avisale al comercio.')
  }
  return parsed.data
}
