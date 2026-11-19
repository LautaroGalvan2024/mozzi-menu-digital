import { useQuery } from '@tanstack/react-query'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { getDeliveryEstimate } from './delivery-api'
import { formatDeliveryDate } from './delivery-schedule'

export function useDeliveryEstimate(restaurantSlug: string | undefined, deliveryZoneId: string | undefined, channel: CommerceChannel = 'menu') {
  return useQuery({
    queryKey: ['delivery-estimate', restaurantSlug, deliveryZoneId, channel],
    enabled: Boolean(restaurantSlug && deliveryZoneId),
    queryFn: ({ signal }) => getDeliveryEstimate(restaurantSlug!, deliveryZoneId!, channel, signal),
    staleTime: 15_000,
    refetchInterval: query => query.state.data?.enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
    retry: 1,
  })
}

export function DeliveryEstimate({ restaurantSlug, deliveryZoneId, channel = 'menu' }: {
  restaurantSlug: string | undefined; deliveryZoneId: string | undefined; channel?: CommerceChannel | undefined
}) {
  const query = useDeliveryEstimate(restaurantSlug, deliveryZoneId, channel)
  if (!restaurantSlug || !deliveryZoneId) return null
  if (query.isError) return <p className="mt-3 text-sm text-stone-600">La fecha de entrega se coordina con el comercio.</p>
  if (!query.data?.enabled) return null
  return <div className="mt-3 rounded-xl bg-stone-50 p-3 text-sm" aria-live="polite">
    <p className="font-semibold">{query.data.estimatedDate ? `Entrega estimada: ${formatDeliveryDate(query.data.estimatedDate)}` : 'Entrega a coordinar'}</p>
    <p className="mt-1 text-xs text-stone-600">El comercio confirma la fecha de entrega.</p>
  </div>
}
