import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

const stageOneSchema = z.object({
  campaigns: z.boolean(),
  sellers: z.boolean(),
  delivery_schedule: z.boolean(),
  assisted_import: z.boolean(),
  stock_design: z.boolean(),
})

type StageOneFeatures = z.infer<typeof stageOneSchema>
export type StageOneFeature = keyof StageOneFeatures

const disabledFeatures: StageOneFeatures = {
  campaigns: false,
  sellers: false,
  delivery_schedule: false,
  assisted_import: false,
  stock_design: false,
}

export function useStageOneFeatures(restaurantId: string | undefined) {
  const query = useQuery({
    queryKey: ['stage-one-features', restaurantId],
    enabled: Boolean(restaurantId),
    staleTime: 15_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!restaurantId) return disabledFeatures
      const { data, error } = await supabase.rpc('get_stage_one_features', { p_restaurant_id: restaurantId }).abortSignal(signal)
      if (error) throw new Error('No pudimos consultar las funciones de este comercio.')
      return stageOneSchema.parse(data)
    },
  })
  return {
    features: query.isError ? disabledFeatures : query.data ?? disabledFeatures,
    loading: Boolean(restaurantId) && query.isPending,
    error: query.error,
    retry: query.refetch,
  }
}
