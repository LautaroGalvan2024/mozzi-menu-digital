import { ArrowLeft, ArrowRight, Check, Clock3, Package, Search, ShoppingBag, Store, Truck, X } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { groupCatalogProducts, productVariants, variantLabel } from '../../lib/catalog-presentation'
import { commercePath } from '../../lib/commerce-channel'
import { currentProductPrice, formatMoney } from '../../lib/money'
import { publicAssetUrl } from '../../lib/supabase/client'
import type { PublicProduct } from '../../types/domain'
import { useCart } from '../cart/CartProvider'
import { ProductDialog } from '../public-menu/ProductDialog'
import { RestaurantHoursDialog } from '../public-menu/RestaurantHoursDialog'
import { usePublicMenu } from '../public-menu/usePublicMenu'
import { readPaymentRecovery } from './payment-recovery'
import './public-store.css'

function ProductImage({ product, detail = false }: { product: PublicProduct; detail?: boolean }) {
  const url = publicAssetUrl(product.family?.imagePath ?? product.imagePath)
  return url ? <img src={url} alt={detail ? product.family?.name ?? product.name : ''} loading={detail ? 'eager' : 'lazy'} /> : (
    <div className="store-image-placeholder" aria-label="Imagen no disponible" role="img"><Package aria-hidden /><span>Imagen no disponible</span></div>
  )
}

export function PublicStorePage() {
  const { restaurantSlug, productId } = useParams()
  const query = usePublicMenu(restaurantSlug, 'store')
  const cart = useCart()
  const { activateRestaurant, reconcileProducts } = cart
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [selected, setSelected] = useState<PublicProduct | null>(null)
  const [showHours, setShowHours] = useState(false)

  useEffect(() => {
    if (restaurantSlug) activateRestaurant(restaurantSlug, 'store')
    setSearch('')
    setCategoryId('')
    setSelected(null)
    setShowHours(false)
  }, [restaurantSlug, activateRestaurant])
  useEffect(() => {
    if (query.data && cart.restaurantSlug === restaurantSlug && cart.channel === 'store') reconcileProducts(query.data.categories.flatMap(category => category.products))
  }, [query.data, query.dataUpdatedAt, cart.restaurantSlug, cart.channel, restaurantSlug, reconcileProducts])

  if (query.isLoading) return <LoadingScreen label="Preparando la tienda…" />
  if (!query.data) return <main className="page-shell py-16"><ErrorPanel title="Tienda no disponible">No encontramos una tienda publicada con esta dirección.<button className="button-secondary mt-4" onClick={() => void query.refetch()}>Reintentar</button></ErrorPanel></main>

  const { restaurant, categories } = query.data
  const products = categories.flatMap(category => category.products)
  const detail = productId ? products.find(product => product.id === productId || product.family?.id === productId) : null
  const detailVariants = detail ? productVariants(detail, products) : []
  const availableVariants = detailVariants.filter(variant => variant.available)
  const phrase = search.trim().toLocaleLowerCase('es')
  const visible = groupCatalogProducts(products.filter(product => (!categoryId || product.categoryId === categoryId) && `${product.family?.name ?? ''} ${product.name} ${product.family?.description ?? ''} ${product.description} ${product.code} ${variantLabel(product)}`.toLocaleLowerCase('es').includes(phrase)))
  const hasFilters = Boolean(search || categoryId)
  const cover = publicAssetUrl(restaurant.coverPath)
  const logo = publicAssetUrl(restaurant.logoPath)
  const money = (amount: number) => formatMoney(amount, restaurant.currencyCode, restaurant.locale)
  const acceptsOrders = restaurant.acceptsOrders ?? restaurant.isOpen
  const recovery = readPaymentRecovery(restaurant.slug)
  const isCurrentCart = cart.channel === 'store' && cart.restaurantSlug === restaurant.slug
  const itemCount = isCurrentCart ? cart.itemCount : 0
  const storePath = commercePath(restaurant.slug, 'store')
  const clearFilters = () => { setSearch(''); setCategoryId('') }

  return <div className="public-store" style={{ '--brand': restaurant.primaryColor } as CSSProperties}>
    <a href="#store-catalog" className="store-skip-link">Ir a los productos</a>
    <header className="store-header">
      <div className="page-shell">
        <div className="store-topbar">
          <Link to={storePath} className="store-identity">
            <span className="store-logo">{logo ? <img src={logo} alt="" /> : <Store aria-hidden />}</span>
            <div className="min-w-0"><span className="store-eyebrow">Tienda online</span><h1>{restaurant.tradeName}</h1></div>
          </Link>
          <Link to={commercePath(restaurant.slug, 'store', '/carrito')} className="store-cart-link" aria-label={`Ver carrito, ${itemCount} productos`}>
            <ShoppingBag aria-hidden /><span className="hidden sm:inline">Carrito</span><span className="store-cart-count">{itemCount}</span>
          </Link>
        </div>
        <div className={`store-intro ${cover ? 'store-intro-with-cover' : ''}`}>
          <div className="store-intro-content">
            {restaurant.description ? <p className="store-description">{restaurant.description}</p> : null}
            <div className="store-attention">
              <span className={`store-order-status ${acceptsOrders ? 'is-available' : 'is-paused'}`}><span aria-hidden />{acceptsOrders ? 'Recibimos pedidos' : 'Pedidos pausados'}</span>
              <button className="store-hours" onClick={() => setShowHours(true)}><Clock3 aria-hidden />Atención: {restaurant.isOpen ? 'abierto ahora' : 'fuera de horario'}</button>
            </div>
            {restaurant.pickupEnabled || restaurant.deliveryEnabled ? <div className="store-fulfillment">
              {restaurant.pickupEnabled ? <span><Store aria-hidden />Retiro en el local</span> : null}
              {restaurant.deliveryEnabled ? <span><Truck aria-hidden />Envíos locales</span> : null}
            </div> : null}
          </div>
          {cover ? <img className="store-cover" src={cover} alt="" /> : null}
        </div>
      </div>
    </header>

    <main id="store-catalog" className="page-shell store-main" tabIndex={-1}>
      {recovery ? <Link className="store-recovery" to={commercePath(restaurant.slug, 'store', '/pago')}>
        <span className="store-recovery-icon"><ShoppingBag aria-hidden /></span>
        <span><strong>Consultar mi última compra</strong><span>Revisá el estado de tu pedido y de tu pago.</span></span>
        <ArrowRight aria-hidden />
      </Link> : null}

      {productId ? detail ? <section aria-labelledby="store-product-title">
        <Link className="store-back" to={storePath}><ArrowLeft aria-hidden />Todos los productos</Link>
        <div className="store-product-detail">
          <div className="store-detail-image"><ProductImage product={detail} detail /></div>
          <div className="store-detail-content">
            <p className="store-eyebrow">{categories.find(category => category.id === detail.categoryId)?.name}</p>
            <h2 id="store-product-title">{detail.family?.name ?? detail.name}</h2>
            <span className={`store-availability ${availableVariants.length ? '' : 'is-unavailable'}`}>{availableVariants.length ? <Check aria-hidden /> : null}{availableVariants.length ? 'Disponible' : 'Agotado'}</span>
            <p className="store-detail-price">{detail.family ? <span>Desde </span> : null}{money(Math.min(...detailVariants.map(variant => currentProductPrice(variant))))}</p>
            {(detail.family?.description ?? detail.description) ? <p className="store-detail-description">{detail.family?.description ?? detail.description}</p> : null}
            {detail.family ? <div className="store-variant-summary">
              <p>{detailVariants.length} {detailVariants.length === 1 ? 'variante' : 'variantes'}<span> · {availableVariants.length} {availableVariants.length === 1 ? 'disponible' : 'disponibles'}</span></p>
              <dl>{detail.family.axes.map(axis => <div key={axis}><dt>{axis}</dt><dd>{[...new Set(detailVariants.map(variant => variant.variantAttributes?.[axis]).filter(Boolean))].join(' · ')}</dd></div>)}</dl>
            </div> : null}
            <div className="store-detail-action">
              <button className="button-primary" disabled={!availableVariants.length || !acceptsOrders} onClick={() => setSelected(availableVariants[0] ?? detail)}>
                {detail.family ? 'Elegir variante' : 'Agregar al carrito'}<ArrowRight aria-hidden />
              </button>
              <p>{!availableVariants.length ? 'Por el momento, este producto no tiene stock disponible.' : !acceptsOrders ? 'El comercio tiene los pedidos pausados. Podés seguir explorando el catálogo.' : detail.family ? 'Elegí una combinación para ver su precio y agregarla al carrito.' : 'Podés revisar las cantidades antes de confirmar tu pedido.'}</p>
            </div>
            {restaurant.pickupEnabled || restaurant.deliveryEnabled ? <div className="store-detail-delivery">
              {restaurant.pickupEnabled ? <span><Store aria-hidden /><span><strong>Retiro en el local</strong>{restaurant.address ? <small>{restaurant.address}</small> : null}</span></span> : null}
              {restaurant.deliveryEnabled ? <span><Truck aria-hidden /><span><strong>Envíos locales</strong><small>Consultá las zonas y el costo al finalizar.</small></span></span> : null}
            </div> : null}
          </div>
        </div>
      </section> : <ErrorPanel title="Producto no disponible">Este producto ya no está en el catálogo. <Link className="underline" to={storePath}>Volver a la tienda</Link></ErrorPanel> : <>
        <div className="store-catalog-heading"><div><p className="store-eyebrow">El catálogo</p><h2>Encontrá lo que buscás</h2></div><p className="store-result-count" role="status" aria-live="polite">{visible.length} {visible.length === 1 ? 'producto' : 'productos'}</p></div>
        <div className="store-filters">
          <label className="store-search"><span className="sr-only">Buscar productos</span><Search aria-hidden /><input placeholder="Buscar productos, modelos, colores…" value={search} onChange={event => setSearch(event.target.value)} /></label>
          {search ? <button className="store-clear-search" aria-label="Limpiar búsqueda" onClick={() => setSearch('')}><X aria-hidden /></button> : null}
        </div>
        {categories.length ? <nav className="store-categories" aria-label="Categorías de productos">
          <button aria-pressed={!categoryId} onClick={() => setCategoryId('')}>Todos</button>
          {categories.map(category => <button key={category.id} aria-pressed={categoryId === category.id} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}
        </nav> : null}
        {hasFilters ? <div className="store-active-filters"><p>{categoryId ? categories.find(category => category.id === categoryId)?.name : 'Todos los productos'}{phrase ? <> · “{search.trim()}”</> : null}</p><button onClick={clearFilters}>Limpiar filtros<X aria-hidden /></button></div> : null}

        {visible.length ? <div className={`store-grid ${visible.length === 1 ? 'is-single' : ''}`}>{visible.map(product => {
          const variants = productVariants(product, products)
          const available = variants.some(variant => variant.available)
          const price = Math.min(...variants.map(variant => currentProductPrice(variant)))
          return <article key={product.family?.id ?? product.id} className="store-product-card">
            <Link to={commercePath(restaurant.slug, 'store', `/producto/${product.family?.id ?? product.id}`)}>
              <div className="store-card-image"><ProductImage product={product} />{!available ? <span className="store-sold-out">Agotado</span> : null}</div>
              <div className="store-card-content">
                <h3>{product.family?.name ?? product.name}</h3>
                <p className="store-card-price">{product.family ? <span>Desde </span> : null}{money(price)}</p>
                <div className="store-card-bottom"><p>{product.family ? `${variants.length} ${variants.length === 1 ? 'variante' : 'variantes'}` : available ? 'Disponible' : 'Sin stock'}</p><ArrowRight aria-hidden /></div>
              </div>
            </Link>
          </article>
        })}</div> : <section className="store-empty" aria-labelledby="store-empty-title">
          <span className="store-empty-icon">{hasFilters ? <Search aria-hidden /> : <Package aria-hidden />}</span>
          <h3 id="store-empty-title">{hasFilters ? 'No encontramos productos' : 'El catálogo está en preparación'}</h3>
          <p>{hasFilters ? 'Probá con otro nombre, modelo o color, o explorá todas las categorías.' : 'Este comercio todavía no tiene productos publicados. Volvé a visitarnos más adelante.'}</p>
          {hasFilters ? <button className="button-secondary" onClick={clearFilters}>Ver todos los productos<ArrowRight aria-hidden /></button> : null}
        </section>}
      </>}
    </main>

    {itemCount > 0 ? <div className="store-cart-dock"><Link to={commercePath(restaurant.slug, 'store', '/carrito')}><span><ShoppingBag aria-hidden />Ver carrito · {itemCount}</span><span>{money(cart.subtotalCents)}<ArrowRight aria-hidden /></span></Link></div> : null}
    {selected ? <ProductDialog product={selected} variants={productVariants(selected, products)} restaurant={restaurant} onClose={() => setSelected(null)} onAdd={line => { cart.addLine(line); setSelected(null) }} /> : null}
    {showHours ? <RestaurantHoursDialog restaurantName={restaurant.tradeName} timeZone={restaurant.timezone} locale={restaurant.locale} businessHours={query.data.businessHours} specialHours={query.data.specialHours} onClose={() => setShowHours(false)} /> : null}
  </div>
}
