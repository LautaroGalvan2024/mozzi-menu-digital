import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, Download, Share2 } from 'lucide-react'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { useCommerceChannel, commercePath } from '../../lib/commerce-channel'
import { currentProductPrice, formatMoney } from '../../lib/money'
import { cartProductName } from '../../lib/catalog-presentation'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { whatsappShareUrl } from '../../lib/phone'
import { env } from '../../lib/env'
import { getPublicCampaign } from './api'
import { campaignPath, productCampaignPath } from './campaigns'
import { effectiveQuantityPrices } from '../../lib/quantity-pricing'
import './campaigns.css'

export function PublicCampaignPage() {
  const { restaurantSlug = '', campaignSlug = '' } = useParams(); const channel = useCommerceChannel()
  const query = useQuery({ queryKey: ['public-campaign', restaurantSlug, campaignSlug, channel], queryFn: () => getPublicCampaign(restaurantSlug, campaignSlug, channel), refetchInterval: 30_000, refetchOnWindowFocus: 'always', staleTime: 10_000, retry: 1 })
  const [exporting, setExporting] = useState(false); const [progress, setProgress] = useState(''); const [error, setError] = useState(''); const [expiredAt, setExpiredAt] = useState(0)
  const { data: response, dataUpdatedAt, refetch } = query
  useEffect(() => {
    if (!response?.validUntil) return
    const delay = Math.max(0, Date.parse(response.validUntil) - Date.parse(response.serverNow) - (Date.now() - response.clientAnchorAt))
    const timer = setTimeout(() => { setExpiredAt(dataUpdatedAt); void refetch() }, Math.min(delay + 10, 2_147_000_000))
    return () => clearTimeout(timer)
  }, [response, dataUpdatedAt, refetch])
  async function download() {
    setExporting(true); setError(''); setProgress('Preparando PDF…')
    try {
      const fresh = await getPublicCampaign(restaurantSlug, campaignSlug, channel)
      if (!fresh || fresh.expired) throw new Error('La revista ya no está vigente. Volvé al catálogo.')
      const { downloadCampaignPdf } = await import('./campaign-pdf')
      await downloadCampaignPdf(fresh, channel, (current, total) => setProgress(`Preparando ${current} de ${total} productos…`))
      setProgress('PDF descargado.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos descargar el PDF.') }
    finally { setExporting(false) }
  }
  if (query.isLoading) return <LoadingScreen label="Preparando la revista…" />
  const back = <Link className="button-secondary" to={commercePath(restaurantSlug, channel)}><ArrowLeft aria-hidden className="h-4 w-4" />Volver al catálogo</Link>
  if (!query.data || query.isError) return <main className="page-shell py-10"><ErrorPanel title="Revista no disponible" action={back}>Esta publicación no está disponible ahora. Podés consultar el catálogo del comercio.</ErrorPanel></main>
  const data = query.data; const { campaign, restaurant } = data; const now = new Date(data.serverNow); const image = responsiveAssetUrls(campaign.imagePath)
  const logo = responsiveAssetUrls(restaurant.logoPath)
  const brandColor = /^#[\da-f]{6}$/i.test(restaurant.primaryColor) ? restaurant.primaryColor : '#ff6d00'
  const stale = expiredAt === query.dataUpdatedAt
  const url = new URL(campaignPath(restaurant.slug, channel, campaign), `${env.appBaseUrl}/`).toString()
  return <main className="campaign-public page-shell py-7">
    {back}<header className="campaign-public-header" style={{ borderTop: `4px solid ${brandColor}`, paddingTop: 20 }}>{image.src ? <img src={image.src} srcSet={image.srcSet} sizes="(min-width: 768px) 360px, 100vw" alt="" /> : null}<div>{logo.src ? <img src={logo.src} srcSet={logo.srcSet} sizes="56px" className="mb-3 h-14 w-14 rounded-lg object-contain" alt={`Logo de ${restaurant.tradeName}`} /> : null}<p className="campaign-eyebrow">{restaurant.tradeName}</p><h1>{campaign.title}</h1>{campaign.description ? <p>{campaign.description}</p> : null}{campaign.endsAt ? <p className="text-sm">Hasta el {new Date(campaign.endsAt).toLocaleString(restaurant.locale, { timeZone: restaurant.timezone })}</p> : null}</div></header>
    {data.expired ? <section className="form-card"><h2 className="form-card-title">Esta revista finalizó</h2><p className="mt-2">Visitá el catálogo para consultar los productos y precios actuales.</p></section> : <>
      <div className="mb-6 flex flex-wrap gap-3"><a className="button-primary" href={whatsappShareUrl(`${campaign.title} · ${restaurant.tradeName}\n${url}`)} target="_blank" rel="noreferrer"><Share2 className="h-4 w-4" aria-hidden />Compartir por WhatsApp</a><button className="button-secondary" disabled={exporting || stale} onClick={() => void download()}><Download className="h-4 w-4" aria-hidden />{exporting ? 'Preparando PDF…' : 'Descargar PDF'}</button></div>
      {error ? <p className="form-error mb-4" role="alert">{error}</p> : null}{progress ? <p className="mb-4 text-sm" role="status">{progress}</p> : null}
      <p className="mb-5 text-sm text-stone-600">Precios y disponibilidad del catálogo actual. El PDF guarda una copia fechada.</p>
      {stale ? <p role="status">Actualizando precios… <button className="underline" onClick={() => void query.refetch()}>Reintentar</button></p> : <div className="campaign-product-grid">{data.products.map(product => {
        const photo = responsiveAssetUrls(product.imagePath ?? product.family?.imagePath ?? null); const price = currentProductPrice(product, now); const pack = effectiveQuantityPrices(price, product.quantityPrices)[0]
        const threshold = product.quantityThreshold
        return <article key={product.id} className="campaign-product"><div className="campaign-product-photo">{photo.src ? <img src={photo.src} srcSet={photo.srcSet} sizes="(min-width: 768px) 250px, 45vw" alt="" loading="lazy" /> : <span>Sin foto</span>}</div><h2>{cartProductName(product)}</h2><p className="text-xs text-stone-500">{product.code}</p><strong className="campaign-price">{formatMoney(price, restaurant.currencyCode, restaurant.locale)}</strong>{threshold && threshold.unitPriceCents < price ? <p className="text-sm">Desde {threshold.minimumQuantity}: {formatMoney(threshold.unitPriceCents, restaurant.currencyCode, restaurant.locale)} c/u</p> : pack ? <p className="text-sm">{pack.quantity} por {formatMoney(pack.totalPriceCents, restaurant.currencyCode, restaurant.locale)}</p> : null}{!product.available ? <p className="text-sm text-amber-800">Agotado</p> : null}<Link className="button-secondary mt-auto" to={productCampaignPath(restaurant.slug, channel, product.id, product.family?.id)}>Ver producto</Link></article>
      })}</div>}
      {!data.products.length ? <p>Los productos de esta selección ya no están publicados. Consultá el catálogo actual.</p> : null}
    </>}
  </main>
}
