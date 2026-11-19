import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'
import { campaignError, campaignSchema, type CampaignDraft } from './campaigns'

export async function getAdminCampaigns(restaurantId: string) {
  const result = await supabase.rpc('get_admin_campaigns', { p_restaurant_id: restaurantId })
  if (result.error) throw new Error(result.error.code === 'PGRST202' ? 'Las publicaciones todavía no están habilitadas en este entorno.' : 'No se pudieron cargar las publicaciones.')
  return z.array(campaignSchema).parse(result.data)
}
export interface CampaignSaveRequest { restaurantId: string; requestId: string; draft: CampaignDraft }
export async function saveCampaign(request: CampaignSaveRequest) {
  const { id, version, ...document } = request.draft
  const result = await supabase.rpc('save_campaign', { p_restaurant_id: request.restaurantId, p_id: id, p_request_id: request.requestId, p_expected_version: version, p_document: document })
  if (result.error) {
    const failure = new Error(campaignError(result.error)) as Error & { definitive?: boolean }
    failure.definitive = ['22023', '23514', '23502', '42501', '40001', 'PT409', '22P02'].includes(result.error.code ?? '')
    throw failure
  }
  return campaignSchema.parse(result.data)
}
