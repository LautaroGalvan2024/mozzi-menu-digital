import { z } from 'zod'
import { commercePath, type CommerceChannel } from '../../lib/commerce-channel'
import { publicMenuSchema, publicProductSchema } from '../../lib/validation/schemas'

export const campaignSchema = z.object({
  id: z.string().uuid(), slug: z.string(), kind: z.enum(['magazine', 'banner']), title: z.string().min(1).max(120),
  description: z.string().max(1000), imagePath: z.string().nullable(), channels: z.array(z.enum(['menu', 'store'])).min(1).max(2),
  status: z.enum(['draft', 'published', 'paused']), startsAt: z.string().nullable(), endsAt: z.string().nullable(),
  productIds: z.array(z.string().uuid()).max(100), targetKind: z.enum(['catalog', 'product', 'category']), targetId: z.string().uuid().nullable(),
  sortOrder: z.number().int().min(0).max(9999), version: z.number().int().positive(), updatedAt: z.string(),
})
export type Campaign = z.infer<typeof campaignSchema>
export type CampaignDraft = Omit<Campaign, 'slug' | 'version' | 'updatedAt'> & { version: number | null }
export const publicCampaignSchema = z.object({
  campaign: campaignSchema, restaurant: publicMenuSchema.shape.restaurant, products: z.array(publicProductSchema),
  expired: z.boolean(), serverNow: z.string(), validUntil: z.string().nullable(),
})
export type PublicCampaign = z.infer<typeof publicCampaignSchema>
export const campaignListSchema = z.object({ items: z.array(campaignSchema), serverNow: z.string(), validUntil: z.string().nullable() })

export function newCampaign(kind: Campaign['kind'], channels: CommerceChannel[]): CampaignDraft {
  return { id: crypto.randomUUID(), kind, title: '', description: '', imagePath: null, channels: channels.length ? channels : ['store'], status: 'draft', startsAt: null, endsAt: null, productIds: [], targetKind: 'catalog', targetId: null, sortOrder: 0, version: null }
}
export function campaignState(campaign: Pick<Campaign, 'status' | 'startsAt' | 'endsAt'>, now = Date.now()) {
  if (campaign.status === 'draft') return 'Borrador'
  if (campaign.status === 'paused') return 'Pausada'
  if (campaign.endsAt && Date.parse(campaign.endsAt) <= now) return 'Finalizada'
  if (campaign.startsAt && Date.parse(campaign.startsAt) > now) return 'Programada'
  return 'Publicada'
}
export function campaignPath(slug: string, channel: CommerceChannel, campaign: Pick<Campaign, 'slug'>) {
  return commercePath(slug, channel, `/revista/${encodeURIComponent(campaign.slug)}`)
}
export function productCampaignPath(slug: string, channel: CommerceChannel, id: string, familyId?: string | null) {
  return channel === 'store'
    ? `${commercePath(slug, channel, `/producto/${familyId ?? id}`)}?variante=${encodeURIComponent(id)}`
    : `${commercePath(slug, channel)}?producto=${encodeURIComponent(familyId ?? id)}&variante=${encodeURIComponent(id)}`
}
export function bannerPath(slug: string, channel: CommerceChannel, campaign: Campaign) {
  if (campaign.kind === 'magazine') return campaignPath(slug, channel, campaign)
  if (campaign.targetKind === 'product' && campaign.targetId) return productCampaignPath(slug, channel, campaign.targetId)
  if (campaign.targetKind === 'category' && campaign.targetId) return `${commercePath(slug, channel)}?category=${encodeURIComponent(campaign.targetId)}`
  return commercePath(slug, channel)
}
export function parseCodes(value: string) { return [...new Set(value.split(/[\r\n\t,;]+/).map(code => code.trim()).filter(Boolean))] }
export function localDateTime(iso: string | null, timeZone: string) {
  if (!iso) return ''
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`
}
/** Resolve a merchant-local wall time, rejecting DST gaps and repeated times. */
export function dateTimeInZone(value: string, timeZone: string): string | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Revisá la fecha y la hora.')
  const utc = Date.parse(`${value}:00Z`)
  if (!Number.isFinite(utc)) throw new Error('Revisá la fecha y la hora.')
  const candidates = new Set<string>()
  // Time zones include quarter-hour offsets. Search a bounded window, including DST folds.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const iso = new Date(utc + offset * 60_000).toISOString()
    if (localDateTime(iso, timeZone) === value) candidates.add(iso)
  }
  if (candidates.size !== 1) throw new Error('Esa hora no es única o no existe por un cambio de horario. Elegí otra hora.')
  return [...candidates][0]!
}
export function campaignError(error: { message?: string; code?: string } | null) {
  const message = error?.message ?? ''
  if (message.includes('CAMPAIGN_CHANGED')) return 'Otra persona cambió esta publicación. Volvé al listado y abrí la versión actual.'
  if (message.includes('CHANNEL_UNPUBLISHED')) return 'Publicá primero los canales elegidos o guardá un borrador.'
  if (message.includes('EXPIRED')) return 'La fecha de finalización ya pasó. Elegí una fecha futura.'
  if (message.includes('EMPTY')) return 'Elegí al menos un producto para publicar la revista.'
  if (message.includes('PRODUCT_INVALID')) return 'Un producto fue archivado o ya no está disponible en tu catálogo. Revisá la selección.'
  if (message.includes('IMAGE')) return 'La imagen ya no está disponible. Volvé a seleccionarla.'
  if (message.includes('FORBIDDEN')) return 'Tu sesión no tiene permiso para administrar estas publicaciones.'
  return 'No pudimos confirmar el guardado. Reintentá para recuperar el mismo envío.'
}
