import { Package, Search, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { publicAssetUrl } from '../../lib/supabase/public-assets'
import type { PublicProduct } from '../../types/domain'
import './store-product-media.css'

export function StoreProductMedia({ product, familyImagePath = null, detail = false }: {
  product: PublicProduct
  familyImagePath?: string | null
  detail?: boolean
}) {
  const path = detail ? product.imagePath ?? familyImagePath : familyImagePath ?? product.imagePath
  return <ProductImage key={`${path ?? ''}:${detail}`} path={path} name={product.family?.name ?? product.name} detail={detail} />
}

function ProductImage({ path, name, detail }: { path: string | null; name: string; detail: boolean }) {
  const image = responsiveAssetUrls(path)
  const primary = publicAssetUrl(path)
  const [usePrimary, setUsePrimary] = useState(false)
  const [failed, setFailed] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  if (!image.src || failed) {
    return <div className="store-image-placeholder store-product-media-fallback" role="img" aria-label={failed ? 'Foto no disponible' : 'Producto sin foto'}>
      <Package aria-hidden /><span>{failed ? 'Foto no disponible' : 'Sin imagen'}</span>
    </div>
  }

  function handleError() {
    // A legacy upload may be missing a derivative; try the stored primary before
    // replacing the photo. Reset all image state when its path changes.
    if (image.srcSet && primary && !usePrimary) setUsePrimary(true)
    else setFailed(true)
  }

  const picture = <picture className="store-product-media">
    <img
      src={usePrimary ? primary! : image.src}
      srcSet={usePrimary ? undefined : image.srcSet}
      sizes={detail ? '(min-width: 900px) 460px, 80vw' : '(min-width: 1024px) 240px, (min-width: 640px) 28vw, 42vw'}
      alt={detail ? name : ''}
      loading={detail ? 'eager' : 'lazy'}
      decoding="async"
      onError={handleError}
    />
  </picture>

  if (!detail) return picture

  return <>
    <button type="button" className="store-detail-image-button store-product-media-trigger" onClick={() => dialogRef.current?.showModal()} aria-label={`Ampliar foto de ${name}`}>
      {picture}<span><Search aria-hidden />Ampliar</span>
    </button>
    <dialog ref={dialogRef} className="store-image-dialog" aria-label={`Foto ampliada de ${name}`} onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close()
    }}>
      <button type="button" onClick={() => dialogRef.current?.close()} aria-label="Cerrar foto"><X aria-hidden /></button>
      <img src={primary ?? image.src} alt={name} decoding="async" />
    </dialog>
  </>
}
