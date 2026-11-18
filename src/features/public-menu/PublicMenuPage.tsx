import { Clock3, MapPin, MessageCircle, Search, ShoppingBag, Store, Utensils } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { useCart } from '../cart/CartProvider'
import { env } from '../../lib/env'
import { formatNextOpeningAt } from '../../lib/hours'
import { formatMoney, currentProductPrice } from '../../lib/money'
import { readOrderRecovery } from '../../lib/order-recovery'
import { whatsappShareUrl } from '../../lib/phone'
import { effectiveQuantityPrices } from '../../lib/quantity-pricing'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import type { PublicCatalogGroup } from '../../types/domain'
import { ProductDialog } from './ProductDialog'
import { RestaurantHoursDialog } from './RestaurantHoursDialog'
import { usePublicCatalog } from './usePublicCatalog'
import './menu-experience.css'

function RecentOrderLink({ slug }: { slug: string }) {
  const [reference] = useState(() => readOrderRecovery(slug))
  return reference ? <div className="page-shell py-3"><Link className="block rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900 underline" to={`/r/${slug}/pedido-generado`}>Recuperar mi último pedido y el mensaje de WhatsApp</Link></div> : null
}

const INITIAL_VISIBLE_GROUPS = 12

export function catalogGroupPresentation(group: PublicCatalogGroup) {
  const first = group.variants[0]
  if (!first) return null
  const availableVariants = group.variants.filter((variant) => variant.available)
  const available = availableVariants.length > 0
  const representative = availableVariants[0] ?? first
  const pricedVariants = available ? availableVariants : group.variants
  return {
    available,
    price: Math.min(...pricedVariants.map((variant) => currentProductPrice(variant))),
    product: { ...representative, family: group.family ?? representative.family },
  }
}

export function PublicMenuPage() {
  const { restaurantSlug } = useParams()
  const cart = useCart()
  const { activateRestaurant, reconcileProducts } = cart
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [showHours, setShowHours] = useState(false)
  const debouncedSearch = useDebouncedValue(search, 300)
  const catalog = usePublicCatalog(restaurantSlug, 'menu', categoryId, debouncedSearch)
  const filterKey = `${restaurantSlug ?? ''}:${categoryId}:${debouncedSearch.trim()}`
  const [visibleState, setVisibleState] = useState({ key: filterKey, count: INITIAL_VISIBLE_GROUPS })
  const visibleCount = visibleState.key === filterKey ? visibleState.count : INITIAL_VISIBLE_GROUPS
  const visibleGroups = catalog.groups.slice(0, visibleCount)
  const cards = useMemo(() => visibleGroups.flatMap((group) => {
    const presentation = catalogGroupPresentation(group)
    return presentation ? [{ group, ...presentation }] : []
  }), [visibleGroups])
  const selectedGroup = catalog.groups.find((group) => group.id === selectedGroupId)
  const selectedProduct = selectedGroup ? catalogGroupPresentation(selectedGroup)?.product ?? null : null

  useEffect(() => {
    if (restaurantSlug) activateRestaurant(restaurantSlug)
  }, [activateRestaurant, restaurantSlug])

  useEffect(() => {
    if (!catalog.meta.data || cart.restaurantSlug !== catalog.meta.data.restaurant.slug || (cart.channel ?? 'menu') !== 'menu') return
    reconcileProducts(catalog.groups.flatMap((group) => group.variants))
  }, [cart.restaurantSlug, cart.channel, catalog.groups, catalog.meta.data, reconcileProducts])

  if (!env.isSupabaseConfigured) return <main className="menu-experience menu-state page-shell py-16"><ErrorPanel title="Falta conectar Supabase">Ejecutá <code>npm run setup:project</code> desde la raíz y reiniciá la aplicación.</ErrorPanel></main>
  if (catalog.isLoading) return <main className="menu-experience menu-state"><LoadingScreen label="Preparando el menú…" /></main>
  if (!catalog.meta.data || !catalog.pages.data) return <main className="menu-experience menu-state page-shell py-16"><ErrorPanel action={<button className="button-secondary" onClick={() => void Promise.all([catalog.meta.refetch(), catalog.pages.refetch()])}>Reintentar</button>}>{catalog.meta.error instanceof Error ? catalog.meta.error.message : catalog.pages.error instanceof Error ? catalog.pages.error.message : 'No encontramos este menú.'}</ErrorPanel></main>

  const { restaurant } = catalog.meta.data
  const selectedCategory = catalog.meta.data.categories.find((category) => category.id === categoryId)
  const hasMoreProducts = visibleCount < catalog.groups.length || catalog.pages.hasNextPage
  const loadMoreProducts = () => {
    if (visibleCount < catalog.groups.length) {
      setVisibleState({ key: filterKey, count: Math.min(catalog.groups.length, visibleCount + 12) })
      return
    }
    setVisibleState({ key: filterKey, count: visibleCount + 24 })
    if (catalog.pages.hasNextPage) void catalog.pages.fetchNextPage()
  }
  const coverImage = responsiveAssetUrls(restaurant.coverPath)
  const logoImage = responsiveAssetUrls(restaurant.logoPath)
  const menuUrl = new URL(`/r/${restaurant.slug}`, `${env.appBaseUrl}/`)
  const previewAssetVersion = (restaurant.coverPath ?? restaurant.logoPath)?.split('/').at(-1)
  if (previewAssetVersion) menuUrl.searchParams.set('v', previewAssetVersion)
  const shareUrl = whatsappShareUrl(`Mirá el menú digital de ${restaurant.tradeName}:\n${menuUrl.toString()}`)
  const nextOpeningLabel = formatNextOpeningAt(restaurant.nextOpeningAt, restaurant.timezone)
  return (
    <div
      className="menu-experience menu-catalog min-h-screen"
      style={{ '--brand': restaurant.primaryColor, '--brand-secondary': restaurant.secondaryColor } as React.CSSProperties}
    >
      <RecentOrderLink key={restaurant.slug} slug={restaurant.slug} />
      <header className={`menu-masthead ${coverImage.src ? 'menu-masthead-with-cover' : 'menu-masthead-no-cover'}`}>
        {coverImage.src ? <div className="menu-cover"><img src={coverImage.src} srcSet={coverImage.srcSet} sizes="(min-width: 1280px) 1200px, 100vw" decoding="async" alt="" fetchPriority="high" /></div> : null}
        <div className="page-shell menu-restaurant">
          <div className="menu-restaurant-title">
            {logoImage.src ? (
              <img
                src={logoImage.src}
                srcSet={logoImage.srcSet}
                sizes="96px"
                decoding="async"
                alt={`Logo de ${restaurant.tradeName}`}
                className="menu-logo"
              />
            ) : (
              <div
                className="menu-logo menu-logo-placeholder"
              >
                <Store className="h-8 w-8" aria-hidden />
              </div>
            )}
            <div className="min-w-0">
              <span className={`menu-open-status ${restaurant.isOpen ? 'is-open' : 'is-closed'}`}>
                {restaurant.isOpen ? 'Abierto ahora' : 'Cerrado'}
              </span>
              <h1 className="menu-restaurant-name">{restaurant.tradeName}</h1>
            </div>
          </div>
          {restaurant.description ? <p className="menu-restaurant-description">{restaurant.description}</p> : null}
          <div className="menu-restaurant-meta">
            <span className="flex items-center gap-1.5"><MapPin className="h-4 w-4" aria-hidden />{restaurant.address}, {restaurant.city}</span>
            <button
              type="button"
              className="menu-hours-trigger"
              onClick={() => setShowHours(true)}
              aria-haspopup="dialog"
            >
              <Clock3 className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                {restaurant.isOpen
                  ? `Demora estimada: ${restaurant.defaultPreparationMinutes} min`
                  : nextOpeningLabel
                    ? `Próxima apertura: ${nextOpeningLabel}`
                    : 'Consultá los horarios'}
                <span className="ml-1.5 font-semibold underline underline-offset-4">Ver horarios</span>
              </span>
            </button>
          </div>
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Compartir el menú de ${restaurant.tradeName} por WhatsApp`}
            className="menu-share"
          >
            <MessageCircle className="h-5 w-5" aria-hidden />
            Compartir por WhatsApp
          </a>
        </div>
      </header>

      <div className="menu-browse-bar sticky top-0 z-30">
        <div className="page-shell menu-browse-inner">
          <label className="menu-search relative block">
            <span className="sr-only">Buscar en el menú</span>
            <Search className="pointer-events-none absolute left-3.5 top-3 h-5 w-5 text-stone-400" aria-hidden />
            <input
              className="h-11 w-full rounded-2xl border border-stone-300 bg-white pl-11 pr-4 text-sm text-stone-950 shadow-sm outline-none transition placeholder:text-stone-400 hover:border-stone-400 focus:border-[var(--brand)] focus:ring-3 focus:ring-[var(--brand)]/15"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar platos, bebidas…"
            />
          </label>
          {catalog.isUpdating ? <p className="mt-2 text-xs font-medium text-stone-500" role="status">Actualizando…</p> : null}
          {catalog.refreshError ? <p className="mt-2 text-xs font-medium text-amber-800" role="status">No se pudo actualizar ahora. Seguís viendo la última versión disponible.</p> : null}
          <nav className="menu-categories scrollbar-none flex gap-2 overflow-x-auto" aria-label="Categorías">
            <button
              type="button"
              aria-pressed={!categoryId}
              onClick={() => setCategoryId('')}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold shadow-sm transition ${!categoryId ? 'border-[var(--brand)] bg-stone-950 text-white' : 'border-stone-300 bg-white text-stone-800 hover:border-[var(--brand)]'}`}
            >Todos</button>
            {catalog.meta.data.categories.map((category) => (
              <button
                type="button"
                key={category.id}
                aria-pressed={categoryId === category.id}
                onClick={() => setCategoryId(category.id)}
                className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold shadow-sm transition ${categoryId === category.id ? 'border-[var(--brand)] bg-stone-950 text-white' : 'border-stone-300 bg-white text-stone-800 hover:border-[var(--brand)] hover:bg-stone-50'}`}
              >
                {category.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="page-shell menu-catalog-content">
          <section className="scroll-mt-40">
            <div className="menu-section-heading">
              <h2 className="font-display text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">{selectedCategory?.name ?? (debouncedSearch.trim() ? 'Resultados' : 'Todos los productos')}</h2>
              {selectedCategory?.description ? <p className="mt-1 max-w-2xl text-sm leading-5 text-stone-600">{selectedCategory.description}</p> : null}
            </div>
            <div className="menu-product-grid">
              {cards.map(({ group, product, price, available }) => {
                const image = responsiveAssetUrls(product.family?.imagePath ?? product.imagePath)
                const hasQuantityPromotion = group.variants.some((variant) => variant.quantityThreshold ? variant.quantityThreshold.unitPriceCents < currentProductPrice(variant) : effectiveQuantityPrices(currentProductPrice(variant), variant.quantityPrices).length > 0)
                return (
                  <article
                    key={group.id}
                    className={`menu-product-card group ${image.src ? '' : 'menu-product-no-photo'}`}
                  >
                    <button
                      className="menu-product-button disabled:cursor-not-allowed"
                      onClick={() => available && setSelectedGroupId(group.id)}
                      disabled={!available}
                    >
                      <div className="menu-product-copy">
                        <div className="menu-product-title">
                          <h3 className="font-display text-lg font-bold leading-tight text-stone-950">{product.family?.name ?? product.name}</h3>
                          {product.featured ? <span className="shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-stone-900" style={{ backgroundColor: 'color-mix(in srgb, var(--brand) 15%, white)', borderColor: 'color-mix(in srgb, var(--brand) 45%, #d6d3d1)' }}>Favorito</span> : null}
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-5 text-stone-600">{product.description}</p>
                        <div className="menu-product-price mt-auto pt-3">
                          <p className="font-display text-base font-bold text-stone-950">{group.variants.length > 1 ? 'Desde ' : ''}{formatMoney(price, restaurant.currencyCode, restaurant.locale)}</p>
                          {price === currentProductPrice(product) && price !== product.basePriceCents ? <p className="mt-0.5 text-xs text-stone-400 line-through">{formatMoney(product.basePriceCents, restaurant.currencyCode, restaurant.locale)}</p> : null}
                          {hasQuantityPromotion ? <span className="mt-1.5 inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-800">Promos por cantidad</span> : null}
                          {!available ? <span className="mt-2 inline-flex rounded-full bg-stone-200 px-2 py-1 text-xs font-bold text-stone-700">Agotado</span> : null}
                        </div>
                      </div>
                      {image.src ? (
                        <img loading="lazy" decoding="async" src={image.src} srcSet={image.srcSet} sizes="(min-width: 768px) 168px, 104px" alt={product.family?.name ?? product.name} className={`menu-product-photo ${!available ? 'grayscale opacity-60' : ''}`} />
                      ) : (
                        <div className="menu-product-photo menu-photo-placeholder" role="img" aria-label="Sin imagen"><Utensils aria-hidden /></div>
                      )}
                    </button>
                  </article>
                )
              })}
            </div>
          </section>
        {cards.length === 0 ? <p className="rounded-3xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-600 shadow-sm">No hay productos que coincidan con la búsqueda.</p> : null}
        {hasMoreProducts ? <div className="mt-7 flex justify-center"><button type="button" className="button-secondary min-w-40" disabled={catalog.pages.isFetchingNextPage} onClick={loadMoreProducts}>{catalog.pages.isFetchingNextPage ? 'Cargando…' : 'Ver más productos'}</button></div> : null}
      </main>

      {cart.restaurantSlug === restaurant.slug && (cart.channel ?? 'menu') === 'menu' && cart.itemCount > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pt-3 sm:px-4" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <Link
            to={`/r/${restaurant.slug}/carrito`}
            className="menu-cart-dock pointer-events-auto mx-auto flex min-h-14 max-w-xl items-center justify-between gap-4 px-4 font-bold text-white sm:px-5"
          >
            <span className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" aria-hidden />Ver carrito · {cart.itemCount}</span>
            <span className="shrink-0">{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</span>
          </Link>
        </div>
      ) : null}
      {selectedProduct && selectedGroup ? <ProductDialog product={selectedProduct} variants={selectedGroup.variants} restaurant={restaurant} onClose={() => setSelectedGroupId(null)} onAdd={(line) => { cart.addLine(line); setSelectedGroupId(null) }} /> : null}
      {showHours ? (
        <RestaurantHoursDialog
          restaurantName={restaurant.tradeName}
          timeZone={restaurant.timezone}
          locale={restaurant.locale}
          businessHours={catalog.meta.data.businessHours}
          specialHours={catalog.meta.data.specialHours}
          onClose={() => setShowHours(false)}
        />
      ) : null}
    </div>
  )
}
