import { beforeEach, expect, it, vi } from 'vitest'
import { saveCampaign } from './admin-api'
import { newCampaign } from './campaigns'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../lib/supabase/client', () => ({ supabase: { rpc } }))
beforeEach(() => rpc.mockReset())

it('treats an HTTP conflict as definitive and preserves the reload instruction', async () => {
  rpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'CAMPAIGN_CHANGED' } })
  await expect(saveCampaign({ restaurantId: 'tenant', requestId: 'request', draft: newCampaign('banner', ['store']) })).rejects.toMatchObject({ definitive: true, message: expect.stringContaining('Volvé al listado') })
})

it('keeps an uncertain connection failure pending for an identical replay', async () => {
  rpc.mockResolvedValue({ data: null, error: { code: '', message: 'Failed to fetch' } })
  await expect(saveCampaign({ restaurantId: 'tenant', requestId: 'request', draft: newCampaign('banner', ['store']) })).rejects.toMatchObject({ definitive: false })
})
