import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { getPublicCampaigns } from './api'
import { bannerPath } from './campaigns'
import './campaigns.css'

/** Independent editorial request: never blocks menu/catalogue readiness. */
export function ActiveCampaignBanners({ slug, channel }: { slug: string; channel: CommerceChannel }) {
  const query = useQuery({ queryKey: ['public-campaigns', slug, channel], queryFn: () => getPublicCampaigns(slug, channel), staleTime: 15_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: false })
  const [expiredAt, setExpiredAt] = useState(0)
  const { data, dataUpdatedAt, refetch } = query
  useEffect(() => {
    if (!data?.validUntil) return
    const delay = Math.max(0, Date.parse(data.validUntil) - Date.parse(data.serverNow) - (Date.now() - data.clientAnchorAt))
    const timer = setTimeout(() => { setExpiredAt(dataUpdatedAt); void refetch() }, Math.min(delay + 10, 2_147_000_000))
    return () => clearTimeout(timer)
  }, [data, dataUpdatedAt, refetch])
  if (!query.data?.items.length || query.isError || expiredAt === query.dataUpdatedAt) return null
  return <section className="campaign-banner-list" aria-label="Novedades y promociones">{query.data.items.map(campaign => {
    const image = responsiveAssetUrls(campaign.imagePath)
    return <Link key={campaign.id} to={bannerPath(slug, channel, campaign)} className="campaign-banner">
      {image.src ? <img src={image.src} srcSet={image.srcSet} sizes="(min-width: 768px) 240px, 35vw" alt="" loading="lazy" /> : null}
      <span><span className="campaign-eyebrow">{campaign.kind === 'magazine' ? 'Nuestra selección' : 'Novedades'}</span><strong>{campaign.title}</strong>{campaign.description ? <span>{campaign.description}</span> : null}</span><ArrowRight aria-hidden />
    </Link>
  })}</section>
}
