import { env } from '../../lib/env'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { campaignListSchema, publicCampaignSchema } from './campaigns'
async function publicRpc(name: 'get_public_campaigns' | 'get_public_campaign', args: Record<string, string>) {
  const result = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: env.supabasePublishableKey, authorization: `Bearer ${env.supabasePublishableKey}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15_000) })
  if (!result.ok) throw new Error('No pudimos cargar esta publicación.')
  return result.json() as Promise<unknown>
}
export async function getPublicCampaigns(slug: string, channel: CommerceChannel) {
  const clientAnchorAt = Date.now()
  const data = await publicRpc('get_public_campaigns', { p_restaurant_slug: slug, p_channel: channel })
  return data === null ? null : { ...campaignListSchema.parse(data), clientAnchorAt }
}
export async function getPublicCampaign(slug: string, campaignSlug: string, channel: CommerceChannel) {
  const clientAnchorAt = Date.now()
  const data = await publicRpc('get_public_campaign', { p_restaurant_slug: slug, p_campaign_slug: campaignSlug, p_channel: channel })
  return data === null ? null : { ...publicCampaignSchema.parse(data), clientAnchorAt }
}
