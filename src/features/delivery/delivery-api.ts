import { z } from 'zod'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { supabase } from '../../lib/supabase/client'
import { deliveryPolicySchema, isCalendarDate, type DeliveryPolicyInput } from './delivery-schedule'

export const deliveryEstimateSchema = z.object({
  enabled: z.boolean(), estimatedDate: z.string().refine(isCalendarDate).nullable(),
  timezone: z.string(), serverNow: z.string().datetime({ offset: true }), label: z.string(),
})
export type DeliveryEstimateQuote = z.infer<typeof deliveryEstimateSchema>

export async function loadDeliverySchedules(restaurantId: string) {
  const result = await supabase.rpc('get_delivery_schedule_policies', { p_restaurant_id: restaurantId })
  if (result.error) throw new Error('No pudimos cargar los días de reparto. Volvé a intentar.')
  return z.array(deliveryPolicySchema).parse(result.data)
}

export type DeliveryZoneInput = {
  name: string; description: string; deliveryFeeCents: number; minimumOrderCents: number
  freeShippingFromCents: number | null; active: boolean; sortOrder: number
}

export async function saveDeliveryZone(input: {
  restaurantId: string; zoneId: string; zone: DeliveryZoneInput; policy: DeliveryPolicyInput | null
  copyZoneIds: string[]; expectedRevision: number
}) {
  const result = await supabase.rpc('save_delivery_zone_settings', {
    p_restaurant_id: input.restaurantId, p_zone_id: input.zoneId, p_zone: input.zone,
    p_policy: input.policy, p_copy_zone_ids: input.copyZoneIds, p_expected_revision: input.expectedRevision,
  })
  if (result.error) {
    if (result.error.message.includes('DELIVERY_SCHEDULE_CHANGED')) throw new Error('Otra persona cambió este calendario. Cerrá esta edición y volvé a abrir la zona para revisar los cambios.')
    if (result.error.message.includes('DELIVERY_SCHEDULE_DAYS_REQUIRED')) throw new Error('Elegí al menos un día de reparto.')
    throw new Error('No pudimos guardar la zona. Revisá los datos y volvé a intentar.')
  }
  const saved = z.object({ saved: z.number().int().positive(), zoneId: z.string().uuid() }).parse(result.data)
  if (saved.zoneId !== input.zoneId) throw new Error('No pudimos confirmar el guardado. Actualizá la lista antes de editar nuevamente.')
  return saved
}

export async function getDeliveryEstimate(slug: string, zoneId: string, channel: CommerceChannel, signal: AbortSignal) {
  const result = await supabase.rpc('get_delivery_estimate', { p_restaurant_slug: slug, p_delivery_zone_id: zoneId, p_channel: channel }).abortSignal(signal)
  if (result.error) throw new Error('No pudimos consultar la entrega estimada.')
  return result.data === null ? null : deliveryEstimateSchema.parse(result.data)
}
