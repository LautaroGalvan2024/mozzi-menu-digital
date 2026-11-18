import { Store } from 'lucide-react'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import type { PublicRestaurant } from '../../types/domain'
import './menu-experience.css'

/** Presentational identity shared by the traditional menu purchase pages. */
export function MenuIdentity({ restaurant }: { restaurant: Pick<PublicRestaurant, 'tradeName' | 'logoPath'> }) {
  const image = responsiveAssetUrls(restaurant.logoPath)
  return <div className="menu-purchase-identity">
    <span className="menu-purchase-mark" aria-hidden>
      {image.src ? <img src={image.src} srcSet={image.srcSet} sizes="40px" alt="" decoding="async" /> : <Store />}
    </span>
    <strong>{restaurant.tradeName}</strong>
  </div>
}
