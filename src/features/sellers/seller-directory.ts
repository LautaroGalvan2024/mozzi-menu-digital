import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

const sellerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  whatsapp_phone: z.string(),
  image_path: z.string().nullable(),
  active: z.boolean(),
  menu_enabled: z.boolean(),
  store_enabled: z.boolean(),
})
export type Seller = z.infer<typeof sellerSchema>

export const sellerDirectoryKey = (restaurantId: string | undefined) => ['sellers', restaurantId] as const

export function useSellerDirectory(restaurantId: string | undefined) {
  return useQuery({
    queryKey: sellerDirectoryKey(restaurantId), enabled: Boolean(restaurantId), retry: false,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.from('sellers')
        .select('id,name,whatsapp_phone,image_path,active,menu_enabled,store_enabled')
        .eq('restaurant_id', restaurantId!).order('name').order('id').abortSignal(signal)
      if (error) throw new Error('No pudimos consultar los vendedores.')
      return sellerSchema.array().parse(data)
    },
  })
}
