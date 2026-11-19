import { describe, expect, it } from 'vitest'
import { bannerPath, campaignState, dateTimeInZone, localDateTime, newCampaign, parseCodes, productCampaignPath } from './campaigns'

describe('campaign publication and sharing rules', () => {
  it('keeps the existing SKU, including leading zeroes and spaces, while deduplicating pasted codes', () => {
    expect(parseCodes('001\nABC 20;001\t002, 003')).toEqual(['001', 'ABC 20', '002', '003'])
  })
  it('does not mark paused/draft campaigns active and treats end as exclusive', () => {
    const now = Date.parse('2026-11-19T15:00:00Z')
    const scheduled = { status: 'published' as const, startsAt: '2026-11-19T16:00:00Z', endsAt: '2026-11-19T18:00:00Z' }
    expect(campaignState(scheduled, now)).toBe('Programada')
    expect(campaignState(scheduled, Date.parse(scheduled.startsAt))).toBe('Publicada')
    expect(campaignState(scheduled, Date.parse(scheduled.endsAt))).toBe('Finalizada')
    expect(campaignState({ ...scheduled, status: 'paused' }, now)).toBe('Pausada')
    expect(campaignState({ ...scheduled, status: 'draft' }, now)).toBe('Borrador')
  })
  it('converts merchant wall time independently from browser timezone', () => {
    expect(dateTimeInZone('2026-11-19T09:30', 'America/Argentina/Buenos_Aires')).toBe('2026-11-19T12:30:00.000Z')
    expect(localDateTime('2026-11-19T12:30:00Z', 'America/Argentina/Buenos_Aires')).toBe('2026-11-19T09:30')
    expect(dateTimeInZone('', 'America/Argentina/Buenos_Aires')).toBeNull()
  })
  it('rejects nonexistent and duplicated daylight-saving wall times', () => {
    expect(() => dateTimeInZone('2026-03-08T02:30', 'America/New_York')).toThrow(/no es única|no existe/)
    expect(() => dateTimeInZone('2026-11-01T01:30', 'America/New_York')).toThrow(/no es única|no existe/)
  })
  it('shares exact variants through durable URLs on both channels', () => {
    expect(productCampaignPath('shop', 'menu', 'sku', 'family')).toBe('/r/shop?producto=family&variante=sku')
    expect(productCampaignPath('shop', 'store', 'sku', 'family')).toBe('/t/shop/producto/family?variante=sku')
  })
  it('creates optional drafts and routes banners only to internal destinations', () => {
    const draft = newCampaign('banner', ['menu'])
    expect(draft.status).toBe('draft'); expect(draft.productIds).toEqual([])
    const campaign = { ...draft, slug: 'publication', version: 1, updatedAt: '2026-11-19T00:00:00Z' }
    expect(bannerPath('shop', 'menu', campaign)).toBe('/r/shop')
    expect(bannerPath('shop', 'store', { ...campaign, targetKind: 'category', targetId: 'category' })).toBe('/t/shop?category=category')
  })
})
