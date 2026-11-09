import { ArrowLeft, ArrowRight, Clock3, Minus, Package, Plus, Search, ShoppingBag, Store, Truck, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { cartProductName } from '../../lib/catalog-presentation'
import { CategoryIconGraphic } from '../../lib/category-icons'
import { commercePath } from '../../lib/commerce-channel'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { currentProductPrice, formatMoney } from '../../lib/money'
import { queryKeys } from '../../lib/queryKeys'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import type { CartLine, PublicCatalogGroup, PublicProduct, PublicRestaurant, PublicStoreCatalogSection } from '../../types/domain'
import { useCart } from '../cart/CartProvider'
import { ProductDialog } from '../public-menu/ProductDialog'
import { RestaurantHoursDialog } from '../public-menu/RestaurantHoursDialog'
import { fetchPublicCatalogGroup } from '../public-menu/api'
import { usePublicStoreCatalog } from '../public-menu/usePublicCatalog'
import { readPaymentRecovery } from './payment-recovery'
import { productBenefit, purchasablePrice, StoreProductConfigurator, StoreProductMedia, StoreServerTimeContext, useStoreServerTime } from './StoreProductConfigurator'
import './public-store.css'

const INITIAL_VISIBLE_GROUPS = 12
const SECTIONS = new Set<PublicStoreCatalogSection>(['all', 'featured', 'offers'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type ProductSelection = { product: PublicProduct; variants: PublicProduct[] }

function representative(group: PublicCatalogGroup, now: Date, preferred?: (variant: PublicProduct) => boolean) {
  const available = group.variants.filter(variant => variant.available)
  const candidates = available.length ? available : group.variants
  const preferredCandidates = preferred ? candidates.filter(preferred) : []
  const pricedCandidates = preferredCandidates.length ? preferredCandidates : candidates
  const product = pricedCandidates.reduce((best, candidate) => currentProductPrice(candidate, now) < currentProductPrice(best, now) ? candidate : best, pricedCandidates[0]!)
  return { ...product, family: group.family ?? product.family }
}

function directLine(product: PublicProduct, familyImagePath: string | null, now: Date): CartLine {
  return { key: crypto.randomUUID(), productId: product.id, productName: cartProductName(product), productImagePath: product.imagePath ?? familyImagePath, quantity: 1, notes: '', unitPriceCents: currentProductPrice(product, now), quantityPrices: product.quantityPrices, quantityThreshold: product.quantityThreshold ?? null, selectedOptions: [] }
}

function ProductCard({ group, section, restaurant, acceptsOrders, detailState, onOpen, onConfigure, onAdd }: { group: PublicCatalogGroup; section: PublicStoreCatalogSection; restaurant: PublicRestaurant; acceptsOrders: boolean; detailState: { from: string }; onOpen: () => void; onConfigure: (selection: ProductSelection) => void; onAdd: (line: CartLine, name: string) => void }) {
  const cart = useCart()
  const now = useStoreServerTime()
  const product = representative(group, now, section === 'offers' ? variant => Boolean(productBenefit(variant, restaurant, now)) : undefined)
  const purchasable = group.variants.some(variant => variant.available)
  const simple = !group.family && group.variants.length === 1 && product.optionGroups.length === 0
  const line = simple ? cart.lines.find(candidate => candidate.productId === product.id && !candidate.notes && candidate.selectedOptions.length === 0) : undefined
  const price = section === 'offers' ? currentProductPrice(product, now) : purchasablePrice(group, now)
  const benefit = productBenefit(product, restaurant, now)
  const filterSearch = detailState.from.includes('?') ? detailState.from.slice(detailState.from.indexOf('?')) : ''
  const path = `${commercePath(restaurant.slug, 'store', `/producto/${group.id}`)}${filterSearch}`
  const money = (amount: number) => formatMoney(amount, restaurant.currencyCode, restaurant.locale)
  const configure = () => onConfigure({ product: product.available ? product : group.variants.find(variant => variant.available) ?? group.variants[0]!, variants: group.variants })
  const productDetailState = { ...detailState, selectedProductId: product.id }

  return <article className="store-product-card">
    <Link className="store-card-media-link" to={path} state={productDetailState} onClick={onOpen} aria-label={`Ver ${group.family?.name ?? product.name}`}><div className="store-card-image"><StoreProductMedia product={product} familyImagePath={group.family?.imagePath ?? null} />{!purchasable ? <span className="store-sold-out">Agotado</span> : benefit?.kind === 'promotion' ? <span className="store-offer-badge">{benefit.label}</span> : null}</div></Link>
    <div className="store-card-content">
      <Link className="store-card-title-link" to={path} state={productDetailState} onClick={onOpen}><h3>{group.family?.name ?? product.name}</h3></Link>
      <div className="store-card-price-row"><p className="store-card-price">{group.family ? <span>{section === 'offers' ? 'Oferta' : 'Desde'}</span> : null}{money(price)}</p>{benefit ? <p className={`store-card-benefit is-${benefit.kind}`}><strong>{benefit.label}</strong><span>{benefit.detail}</span></p> : null}</div>
      <div className="store-card-action">{line ? <div className="store-card-quantity" aria-label={`Cantidad de ${product.name}`}><button type="button" aria-label={`Quitar uno de ${product.name}`} onClick={() => line.quantity === 1 ? cart.removeLine(line.key) : cart.updateQuantity(line.key, line.quantity - 1)}><Minus aria-hidden /></button><span aria-live="polite">{line.quantity}</span><button type="button" aria-label={`Agregar otro ${product.name}`} onClick={() => cart.updateQuantity(line.key, Math.min(100, line.quantity + 1))}><Plus aria-hidden /></button></div> : <button type="button" className="store-card-add" disabled={!purchasable || !acceptsOrders} onClick={() => simple ? onAdd(directLine(product, group.family?.imagePath ?? null, now), product.name) : configure()}>{purchasable ? simple ? 'Agregar' : 'Elegir opciones' : 'Agotado'}{purchasable ? <Plus aria-hidden /> : null}</button>}</div>
    </div>
  </article>
}

function ProductShelf({ id, title, description, section, groups, restaurant, acceptsOrders, detailState, onOpen, onSection, onConfigure, onAdd }: { id: string; title: string; description: string; section: PublicStoreCatalogSection; groups: PublicCatalogGroup[]; restaurant: PublicRestaurant; acceptsOrders: boolean; detailState: { from: string }; onOpen: () => void; onSection: (section: PublicStoreCatalogSection) => void; onConfigure: (selection: ProductSelection) => void; onAdd: (line: CartLine, name: string) => void }) {
  if (!groups.length) return null
  return <section className="store-shelf" aria-labelledby={id}><div className="store-section-heading"><div><p className="store-eyebrow">{section === 'offers' ? 'Beneficios vigentes' : 'Selección del comercio'}</p><h2 id={id}>{title}</h2><p>{description}</p></div><button type="button" onClick={() => onSection(section)}>Ver todos<ArrowRight aria-hidden /></button></div><div className="store-shelf-track">{groups.slice(0, 8).map(group => <ProductCard key={group.id} group={group} section={section} restaurant={restaurant} acceptsOrders={acceptsOrders} detailState={detailState} onOpen={onOpen} onConfigure={onConfigure} onAdd={onAdd} />)}</div></section>
}

export function PublicStorePage() {
  const { restaurantSlug, productId } = useParams()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const cart = useCart()
  const { activateRestaurant, reconcileProducts } = cart
  const sectionParam = params.get('section')
  const section: PublicStoreCatalogSection = sectionParam && SECTIONS.has(sectionParam as PublicStoreCatalogSection) ? sectionParam as PublicStoreCatalogSection : 'all'
  const urlQuery = params.get('q') ?? ''
  const categoryParam = params.get('category') ?? ''
  const urlCategory = UUID.test(categoryParam) ? categoryParam : ''
  const [search, setSearch] = useState(urlQuery)
  const [selection, setSelection] = useState<ProductSelection | null>(null)
  const [showHours, setShowHours] = useState(false)
  const [coverPortrait, setCoverPortrait] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [clientOpenedAt] = useState(() => new Date())
  const restored = useRef(false)
  const searchEdited = useRef(false)
  const debouncedSearch = useDebouncedValue(search, 300)
  const showMerchandising = !productId && !search.trim() && !urlCategory && section === 'all'
  const catalog = usePublicStoreCatalog(restaurantSlug, section, urlCategory, debouncedSearch, 24)
  const offers = usePublicStoreCatalog(showMerchandising ? restaurantSlug : undefined, 'offers', '', '', 8)
  const featured = usePublicStoreCatalog(showMerchandising ? restaurantSlug : undefined, 'featured', '', '', 8)
  const categoryIsInvalid = Boolean(urlCategory && catalog.meta.data && !catalog.meta.data.categories.some(category => category.id === urlCategory))
  const filterKey = `${restaurantSlug ?? ''}:${section}:${urlCategory}:${debouncedSearch.trim()}`
  const [visibleState, setVisibleState] = useState({ key: filterKey, count: INITIAL_VISIBLE_GROUPS })
  const visibleCount = visibleState.key === filterKey ? visibleState.count : INITIAL_VISIBLE_GROUPS
  const groupQuery = useQuery({ queryKey: queryKeys.publicCatalog.group(restaurantSlug, 'store', productId), queryFn: () => fetchPublicCatalogGroup(restaurantSlug ?? '', productId ?? '', 'store'), enabled: Boolean(restaurantSlug && productId), staleTime: Number.POSITIVE_INFINITY, retry: 1 })
  const storeNowMs = catalog.serverNow ? Date.parse(catalog.serverNow) : clientOpenedAt.getTime()
  const storeNow = new Date(storeNowMs)

  useEffect(() => { if (restaurantSlug) activateRestaurant(restaurantSlug, 'store'); setSelection(null); setShowHours(false) }, [restaurantSlug, activateRestaurant])
  useEffect(() => { searchEdited.current = false; setSearch(urlQuery) }, [urlQuery])
  useEffect(() => {
    if (productId) return
    if (!categoryParam || urlCategory) return
    const next = new URLSearchParams(params)
    next.delete('category')
    setParams(next, { replace: true })
  }, [categoryParam, params, productId, setParams, urlCategory])
  useEffect(() => {
    if (productId || !searchEdited.current || debouncedSearch !== search || debouncedSearch === urlQuery) return
    const next = new URLSearchParams(params)
    if (debouncedSearch.trim()) next.set('q', debouncedSearch.trim()); else next.delete('q')
    searchEdited.current = false
    setParams(next, { replace: true })
  }, [debouncedSearch, params, productId, search, setParams, urlQuery])
  useEffect(() => {
    if (productId || !categoryIsInvalid) return
    const next = new URLSearchParams(params)
    next.delete('category')
    setParams(next, { replace: true })
  }, [categoryIsInvalid, params, productId, setParams])
  useEffect(() => {
    const groups = [...catalog.groups, ...offers.groups, ...featured.groups]
    if (catalog.meta.data && cart.restaurantSlug === restaurantSlug && cart.channel === 'store') reconcileProducts(groups.flatMap(group => group.variants), new Date(storeNowMs))
  }, [catalog.groups, catalog.meta.data, cart.restaurantSlug, cart.channel, featured.groups, offers.groups, restaurantSlug, reconcileProducts, storeNowMs])
  useEffect(() => {
    if (productId) {
      restored.current = false
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      return
    }
    if (restored.current) return
    const state = location.state as { restoreScrollY?: number } | null
    let stored: number | null = null
    try {
      const value = sessionStorage.getItem(`mozzi:store-scroll:${restaurantSlug ?? ''}:${location.pathname}${location.search}`)
      stored = value === null ? null : Number(value)
    } catch { /* Scrolling still works when storage is unavailable. */ }
    const target = typeof state?.restoreScrollY === 'number' ? state.restoreScrollY : stored
    if (target === null || !Number.isFinite(target)) return
    restored.current = true
    requestAnimationFrame(() => window.scrollTo({ top: target, behavior: 'instant' }))
  }, [location.pathname, location.search, location.state, productId, restaurantSlug])

  if (categoryIsInvalid || catalog.isLoading || (productId && groupQuery.isLoading)) return <LoadingScreen label="Preparando la tienda…" />
  if (!catalog.meta.data || !catalog.pages.data) return <main className="page-shell py-16"><ErrorPanel title="Tienda no disponible">No encontramos una tienda publicada con esta dirección.<button className="button-secondary mt-4" onClick={() => void catalog.meta.refetch()}>Reintentar</button></ErrorPanel></main>

  const { restaurant, categories } = catalog.meta.data
  const categoryIcons = catalog.pages.data.pages[0]?.categoryIcons ?? {}
  const detailGroup = productId ? groupQuery.data?.group : null
  const phrase = debouncedSearch.trim()
  const visibleGroups = catalog.groups.slice(0, visibleCount)
  const hasFilters = Boolean(search || urlCategory || section !== 'all')
  const cover = responsiveAssetUrls(restaurant.coverPath)
  const logo = responsiveAssetUrls(restaurant.logoPath)
  const money = (amount: number) => formatMoney(amount, restaurant.currencyCode, restaurant.locale)
  const acceptsOrders = restaurant.acceptsOrders ?? restaurant.isOpen
  const recovery = readPaymentRecovery(restaurant.slug)
  const isCurrentCart = cart.channel === 'store' && cart.restaurantSlug === restaurant.slug
  const itemCount = isCurrentCart ? cart.itemCount : 0
  const storePath = commercePath(restaurant.slug, 'store')
  const currentPath = `${location.pathname}${location.search}`
  const detailState = { from: currentPath }
  const detailNavigation = location.state as { from?: string; selectedProductId?: string } | null
  const backPath = detailNavigation?.from ?? `${storePath}${location.search}`
  const hasMoreProducts = visibleCount < catalog.groups.length || catalog.pages.hasNextPage
  const landing = !productId && !hasFilters

  function updateParams(changes: { q?: string; category?: string; section?: PublicStoreCatalogSection }) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) { if (!value || value === 'all' && key === 'section') next.delete(key); else next.set(key, value) }
    setParams(next)
  }
  function editSearch(value: string) { searchEdited.current = true; setSearch(value) }
  function clearFilters() { searchEdited.current = false; setSearch(''); setParams(new URLSearchParams(), { replace: true }) }
  function addLine(line: CartLine, name: string) { cart.addLine(line); setSelection(null); setAnnouncement(`${name} se agregó al carrito.`) }
  function rememberScroll() {
    try { sessionStorage.setItem(`mozzi:store-scroll:${restaurant.slug}:${currentPath}`, String(window.scrollY)) } catch { /* Navigation remains usable without storage. */ }
  }
  function loadMoreProducts() {
    if (visibleCount < catalog.groups.length) { setVisibleState({ key: filterKey, count: Math.min(catalog.groups.length, visibleCount + 12) }); return }
    setVisibleState({ key: filterKey, count: visibleCount + 24 }); if (catalog.pages.hasNextPage) void catalog.pages.fetchNextPage()
  }

  return <StoreServerTimeContext.Provider value={storeNow}><div className={`public-store ${itemCount > 0 ? 'has-cart-dock' : ''}`} style={{ '--brand': restaurant.primaryColor, '--brand-secondary': restaurant.secondaryColor } as CSSProperties}>
    <a href="#store-catalog" className="store-skip-link">Ir a los productos</a><p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    <header className={`store-header ${landing ? 'store-header-landing' : 'store-header-compact'}`}><div className="page-shell">
      <div className="store-topbar"><Link to={storePath} className="store-identity"><span className="store-logo">{logo.src ? <img src={logo.src} srcSet={logo.srcSet} sizes="64px" decoding="async" alt="" /> : <Store aria-hidden />}</span><div className="min-w-0">{landing ? <span className="store-header-label">Tienda online</span> : <><span className="store-eyebrow">Tienda online</span><span className="store-brand-name">{restaurant.tradeName}</span></>}</div></Link><Link to={commercePath(restaurant.slug, 'store', '/carrito')} className="store-cart-link" aria-label={`Ver carrito, ${itemCount} productos`}><ShoppingBag aria-hidden /><span className="hidden sm:inline">Carrito</span><span className="store-cart-count">{itemCount}</span></Link></div>
      {landing ? <section className={`store-hero ${cover.src ? 'has-cover' : 'has-brand-fallback'} ${coverPortrait ? 'has-portrait-cover' : ''}`} aria-labelledby="store-title">{cover.src ? <div className="store-hero-media"><img className="store-hero-image" src={cover.src} srcSet={cover.srcSet} sizes="(min-width: 1160px) 1128px, calc(100vw - 2rem)" decoding="async" fetchPriority="high" alt="" onLoad={event => setCoverPortrait(event.currentTarget.naturalHeight > event.currentTarget.naturalWidth * 1.15)} /></div> : null}<div className="store-hero-panel"><div className="store-hero-copy"><p className="store-hero-eyebrow">Tienda oficial · Compra directa</p><h1 id="store-title">{restaurant.tradeName}</h1>{restaurant.description ? <p className="store-description">{restaurant.description}</p> : null}</div><div className="store-hero-information"><div className="store-attention"><span className={`store-order-status ${acceptsOrders ? 'is-available' : 'is-paused'}`}><span aria-hidden />{acceptsOrders ? 'Recibimos pedidos' : 'Pedidos pausados'}</span><button className="store-hours" onClick={() => setShowHours(true)}><Clock3 aria-hidden />{restaurant.isOpen ? 'Abierto ahora' : 'Ver horarios'}</button></div><div className="store-hero-footer"><div className="store-fulfillment">{restaurant.pickupEnabled ? <span><Store aria-hidden /><span>Retiro{restaurant.address ? <small>{restaurant.address}</small> : null}</span></span> : null}{restaurant.deliveryEnabled ? <span><Truck aria-hidden /><span>Envíos locales</span></span> : null}</div><a className="store-hero-cta" href="#store-products">Explorar productos<ArrowRight aria-hidden /></a></div></div></div></section> : null}
    </div></header>

    <main id="store-catalog" className={`page-shell store-main ${productId ? 'store-main-detail' : ''}`} tabIndex={-1}>
      {!productId && recovery ? <Link className="store-recovery" to={commercePath(restaurant.slug, 'store', '/pago')}><span className="store-recovery-icon"><ShoppingBag aria-hidden /></span><span><strong>Consultar mi última compra</strong><span>Revisá el estado del pedido y del pago.</span></span><ArrowRight aria-hidden /></Link> : null}
      {catalog.isUpdating ? <p className="store-update-status" role="status">Actualizando productos y precios…</p> : null}{catalog.refreshError ? <p className="store-update-status is-error" role="status">No pudimos actualizar ahora. Mostramos la última versión disponible.</p> : null}
      {productId ? detailGroup ? <section aria-labelledby="store-product-title"><Link className="store-back" to={backPath}><ArrowLeft aria-hidden />Volver a productos</Link><StoreProductConfigurator group={detailGroup} restaurant={restaurant} acceptsOrders={acceptsOrders} initialProductId={detailNavigation?.selectedProductId} onAdd={line => addLine(line, line.productName)} />{restaurant.pickupEnabled || restaurant.deliveryEnabled ? <div className="store-detail-delivery"><h2>Formas de entrega</h2><div>{restaurant.pickupEnabled ? <span><Store aria-hidden /><span><strong>Retiro en el local</strong>{restaurant.address ? <small>{restaurant.address}</small> : null}</span></span> : null}{restaurant.deliveryEnabled ? <span><Truck aria-hidden /><span><strong>Envíos locales</strong><small>Elegís la zona y ves el costo al finalizar.</small></span></span> : null}</div></div> : null}</section> : <ErrorPanel title="Producto no disponible" headingLevel={1}>Este producto ya no está en el catálogo. <Link className="underline" to={backPath}>Volver a la tienda</Link></ErrorPanel> : <>
        <section className="store-discovery" aria-label="Buscar en la tienda"><label className="store-search"><span className="sr-only">Buscar productos</span><Search aria-hidden /><input placeholder="¿Qué estás buscando?" value={search} onChange={event => editSearch(event.target.value)} /></label>{search ? <button className="store-clear-search" aria-label="Limpiar búsqueda" onClick={() => editSearch('')}><X aria-hidden /></button> : null}</section>
        {landing && categories.length ? <section className="store-category-showcase" aria-labelledby="store-category-title"><div className="store-section-heading"><div><p className="store-eyebrow">Explorá fácil</p><h2 id="store-category-title">Comprá por categoría</h2></div></div><div className="store-category-track">{categories.map(category => { const image = responsiveAssetUrls(category.imagePath); return <button type="button" key={category.id} onClick={() => updateParams({ category: category.id })}><span className={`store-category-image ${image.src ? '' : 'is-icon'}`}>{image.src ? <img src={image.src} srcSet={image.srcSet} sizes="96px" loading="lazy" decoding="async" alt="" /> : <CategoryIconGraphic name={category.name} iconKey={categoryIcons[category.id] ?? null} />}</span><strong>{category.name}</strong></button> })}</div></section> : null}
        {landing ? <><ProductShelf id="store-offers-title" title="Ofertas para aprovechar" description="Precios y beneficios vigentes en productos disponibles." section="offers" groups={offers.groups} restaurant={restaurant} acceptsOrders={acceptsOrders} detailState={detailState} onOpen={rememberScroll} onSection={value => updateParams({ section: value })} onConfigure={setSelection} onAdd={addLine} /><ProductShelf id="store-featured-title" title="Productos destacados" description="Una selección preparada por el comercio." section="featured" groups={featured.groups} restaurant={restaurant} acceptsOrders={acceptsOrders} detailState={detailState} onOpen={rememberScroll} onSection={value => updateParams({ section: value })} onConfigure={setSelection} onAdd={addLine} /></> : null}
        <section id="store-products" className="store-products-section" aria-labelledby="store-products-title"><div className="store-catalog-heading"><div><p className="store-eyebrow">{section === 'offers' ? 'Promociones' : section === 'featured' ? 'Selección' : 'Todo el catálogo'}</p><h2 id="store-products-title">{section === 'offers' ? 'Todas las ofertas' : section === 'featured' ? 'Productos destacados' : hasFilters ? 'Resultados' : 'Todos los productos'}</h2></div><p className="store-result-count" role="status" aria-live="polite">Mostrando {visibleGroups.length} {visibleGroups.length === 1 ? 'producto' : 'productos'}</p></div><div className="store-catalog-controls">{categories.length ? <nav className="store-categories" aria-label="Filtrar por categoría"><button aria-pressed={!urlCategory} onClick={() => updateParams({ category: '' })}>Todos</button>{categories.map(category => <button key={category.id} aria-pressed={urlCategory === category.id} onClick={() => updateParams({ category: category.id })}>{category.name}</button>)}</nav> : null}{hasFilters ? <div className="store-active-filters"><p>{section === 'offers' ? 'Ofertas' : section === 'featured' ? 'Destacados' : urlCategory ? categories.find(category => category.id === urlCategory)?.name : 'Todos los productos'}{phrase ? <> · “{phrase}”</> : null}</p><button onClick={clearFilters}>Limpiar filtros<X aria-hidden /></button></div> : null}</div>
          {visibleGroups.length ? <><div className={`store-grid ${visibleGroups.length === 1 ? 'is-single' : ''}`}>{visibleGroups.map(group => <ProductCard key={group.id} group={group} section={section} restaurant={restaurant} acceptsOrders={acceptsOrders} detailState={detailState} onOpen={rememberScroll} onConfigure={setSelection} onAdd={addLine} />)}</div>{hasMoreProducts ? <div className="store-load-more"><button type="button" className="button-secondary" disabled={catalog.pages.isFetchingNextPage} onClick={loadMoreProducts}>{catalog.pages.isFetchingNextPage ? 'Cargando…' : 'Ver más productos'}</button></div> : null}</> : <section className="store-empty" aria-labelledby="store-empty-title"><span className="store-empty-icon">{hasFilters ? <Search aria-hidden /> : <Package aria-hidden />}</span><h3 id="store-empty-title">{hasFilters ? 'No encontramos productos' : 'El catálogo está en preparación'}</h3><p>{hasFilters ? 'Probá con otro nombre o explorá todas las categorías.' : 'Este comercio todavía no tiene productos publicados.'}</p>{hasFilters ? <button className="button-secondary" onClick={clearFilters}>Ver todos los productos<ArrowRight aria-hidden /></button> : null}</section>}
        </section>
      </>}
    </main>
    {itemCount > 0 ? <div className="store-cart-dock"><Link to={commercePath(restaurant.slug, 'store', '/carrito')}><span><ShoppingBag aria-hidden />Ver carrito · {itemCount}</span><span>{money(cart.subtotalCents)}<ArrowRight aria-hidden /></span></Link></div> : null}
    {selection ? <ProductDialog product={selection.product} variants={selection.variants} restaurant={restaurant} now={storeNow} onClose={() => setSelection(null)} onAdd={line => addLine(line, line.productName)} /> : null}
    {showHours ? <RestaurantHoursDialog restaurantName={restaurant.tradeName} timeZone={restaurant.timezone} locale={restaurant.locale} businessHours={catalog.meta.data.businessHours} specialHours={catalog.meta.data.specialHours} onClose={() => setShowHours(false)} /> : null}
  </div></StoreServerTimeContext.Provider>
}
