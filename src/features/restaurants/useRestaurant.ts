import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

export const restaurantSchema = z.object({
  store_enabled: z.boolean().default(false),
  store_ordering_policy: z.enum(['always', 'business_hours']).default('always'),
  store_checkout_whatsapp_enabled: z.boolean().default(true),
  store_checkout_online_enabled: z.boolean().default(false),
  id: z.string().uuid(), name: z.string(), trade_name: z.string(), slug: z.string(), description: z.string(), status: z.enum(['draft','active','suspended']), whatsapp_phone_e164: z.string(), address: z.string(), city: z.string(), timezone: z.string(), currency_code: z.string(), locale: z.string(), logo_path: z.string().nullable(), cover_path: z.string().nullable(), primary_color: z.string(), secondary_color: z.string(), delivery_enabled: z.boolean(), pickup_enabled: z.boolean(), minimum_order_cents: z.union([z.number(),z.string()]), default_preparation_minutes: z.number(), public_menu_enabled: z.boolean(), updated_at: z.string(),
})

export type RestaurantRow = z.infer<typeof restaurantSchema>

export function useRestaurant(restaurantId: string | undefined) {
  return useQuery({
    queryKey: ['restaurant', restaurantId],
    enabled: Boolean(restaurantId),
    queryFn: async () => {
      const { data, error } = await supabase.from('restaurants').select('*').eq('id', restaurantId ?? '').single()
      if (error) throw new Error('No se pudo cargar la configuración del restaurante.')
      return restaurantSchema.parse(data)
    },
  })
}
