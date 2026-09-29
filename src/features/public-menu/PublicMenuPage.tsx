import { Clock3, MapPin, MessageCircle, Search, ShoppingBag, Store } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { useCart } from '../cart/CartProvider'
import { env } from '../../lib/env'
import { formatMoney, currentProductPrice } from '../../lib/money'
import { whatsappShareUrl } from '../../lib/phone'
import { publicAssetUrl } from '../../lib/supabase/client'
import type { PublicProduct } from '../../types/domain'
import { ProductDialog } from './ProductDialog'
import { usePublicMenu } from './usePublicMenu'

export function PublicMenuPage() {
  const { restaurantSlug } = useParams()
  const menuQuery = usePublicMenu(restaurantSlug)
  const cart = useCart()
  const { activateRestaurant } = cart
  const [search, setSearch] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<PublicProduct | null>(null)

  useEffect(() => {
    if (restaurantSlug) activateRestaurant(restaurantSlug)
  }, [activateRestaurant, restaurantSlug])

  const categories = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase('es')
    if (!menuQuery.data || !normalized) return menuQuery.data?.categories ?? []
    return menuQuery.data.categories
      .map((category) => ({ ...category, products: category.products.filter((product) => `${product.name} ${product.description} ${product.code}`.toLocaleLowerCase('es').includes(normalized)) }))
      .filter((category) => category.products.length > 0)
  }, [menuQuery.data, search])

  if (!env.isSupabaseConfigured) return <main className="page-shell py-16"><ErrorPanel title="Falta conectar Supabase">Ejecutá <code>npm run setup:project</code> desde la raíz y reiniciá la aplicación.</ErrorPanel></main>
  if (menuQuery.isLoading) return <LoadingScreen label="Preparando el menú…" />
  if (menuQuery.error || !menuQuery.data) return <main className="page-shell py-16"><ErrorPanel action={<button className="button-secondary" onClick={() => void menuQuery.refetch()}>Reintentar</button>}>{menuQuery.error instanceof Error ? menuQuery.error.message : 'No encontramos este menú.'}</ErrorPanel></main>

  const { restaurant } = menuQuery.data
  const coverUrl = publicAssetUrl(restaurant.coverPath)
  const logoUrl = publicAssetUrl(restaurant.logoPath)
  const menuUrl = new URL(`/r/${restaurant.slug}`, `${env.appBaseUrl}/`)
  const previewAssetVersion = (restaurant.coverPath ?? restaurant.logoPath)?.split('/').at(-1)
  if (previewAssetVersion) menuUrl.searchParams.set('v', previewAssetVersion)
  const shareUrl = whatsappShareUrl(`Mirá el menú digital de ${restaurant.tradeName}:\n${menuUrl.toString()}`)
  return (
    <div
      className="min-h-screen bg-[#f7f4ef]"
      style={{ '--brand': restaurant.primaryColor, '--brand-secondary': restaurant.secondaryColor } as React.CSSProperties}
    >
      <header className="relative overflow-hidden border-b-4 border-[var(--brand)] bg-stone-950 text-white">
        <div className="absolute -right-20 -top-28 h-72 w-72 rounded-full opacity-25 blur-3xl" style={{ backgroundColor: 'var(--brand-secondary)' }} />
        {coverUrl ? <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" fetchPriority="high" /> : null}
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(12,10,9,.58)_0%,rgba(12,10,9,.76)_48%,rgba(12,10,9,.96)_100%)]" />
        <div className="page-shell relative flex min-h-[260px] flex-col justify-end py-5 sm:min-h-[310px] sm:py-7">
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Compartir el menú de ${restaurant.tradeName} por WhatsApp`}
            className="absolute right-4 top-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/30 bg-[#25d366] px-3.5 py-2 text-sm font-bold text-[#063b1d] shadow-lg transition hover:-translate-y-0.5 hover:bg-[#20bd5a] focus-visible:outline-white sm:right-6 sm:top-6 sm:px-4"
          >
            <MessageCircle className="h-5 w-5" aria-hidden />
            Compartir por WhatsApp
          </a>
          <div className="flex items-end gap-3 sm:gap-4">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={`Logo de ${restaurant.tradeName}`}
                className="h-20 w-20 shrink-0 rounded-2xl border-2 border-white/90 bg-white object-cover shadow-xl sm:h-24 sm:w-24 sm:rounded-3xl sm:border-4"
              />
            ) : (
              <div
                className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl border-2 border-white/90 shadow-xl sm:h-24 sm:w-24 sm:rounded-3xl sm:border-4"
                style={{ backgroundColor: 'var(--brand)' }}
              >
                <Store className="h-9 w-9 drop-shadow-[0_1px_2px_rgba(0,0,0,.9)] sm:h-10 sm:w-10" aria-hidden />
              </div>
            )}
            <div className="min-w-0 pb-0.5 sm:pb-1">
              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold shadow-sm ${restaurant.isOpen ? 'bg-emerald-400 text-emerald-950' : 'bg-amber-300 text-amber-950'}`}>
                {restaurant.isOpen ? 'Abierto ahora' : 'Cerrado'}
              </span>
              <h1 className="mt-1.5 truncate font-display text-3xl font-bold tracking-tight text-white sm:mt-2 sm:text-4xl">{restaurant.tradeName}</h1>
            </div>
          </div>
          {restaurant.description ? <p className="mt-3 line-clamp-2 max-w-2xl text-sm leading-5 text-stone-200 sm:mt-4 sm:leading-6">{restaurant.description}</p> : null}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs font-medium text-stone-200 sm:gap-y-2">
            <span className="flex items-center gap-1.5"><MapPin className="h-4 w-4 text-white" aria-hidden />{restaurant.address}, {restaurant.city}</span>
            <span className="flex items-center gap-1.5"><Clock3 className="h-4 w-4 text-white" aria-hidden />{restaurant.isOpen ? `Demora estimada: ${restaurant.defaultPreparationMinutes} min` : restaurant.nextOpeningAt ? `Próxima apertura: ${new Date(restaurant.nextOpeningAt).toLocaleString(restaurant.locale, { timeZone: restaurant.timezone })}` : 'Consultá los horarios'}</span>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-30 border-b border-stone-200/90 bg-[#f7f4ef]/95 shadow-[0_1px_12px_rgba(41,37,36,.04)] backdrop-blur">
        <div className="page-shell py-3">
          <label className="relative block">
            <span className="sr-only">Buscar en el menú</span>
            <Search className="pointer-events-none absolute left-3.5 top-3 h-5 w-5 text-stone-400" aria-hidden />
            <input
              className="h-11 w-full rounded-2xl border border-stone-300 bg-white pl-11 pr-4 text-sm text-stone-950 shadow-sm outline-none transition placeholder:text-stone-400 hover:border-stone-400 focus:border-[var(--brand)] focus:ring-3 focus:ring-[var(--brand)]/15"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar platos, bebidas…"
            />
          </label>
          <nav className="scrollbar-none mt-3 flex gap-2 overflow-x-auto pb-0.5" aria-label="Categorías">
            {menuQuery.data.categories.map((category) => (
              <a
                key={category.id}
                href={`#category-${category.id}`}
                className="shrink-0 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 shadow-sm transition hover:border-[var(--brand)] hover:bg-stone-50"
              >
                {category.name}
              </a>
            ))}
          </nav>
        </div>
      </div>

      <main className="page-shell space-y-9 py-7 pb-32 sm:space-y-11 sm:py-9">
        {categories.map((category) => (
          <section key={category.id} id={`category-${category.id}`} className="scroll-mt-40">
            <div className="mb-4 sm:mb-5">
              <h2 className="font-display text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">{category.name}</h2>
              {category.description ? <p className="mt-1 max-w-2xl text-sm leading-5 text-stone-600">{category.description}</p> : null}
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
              {category.products.map((product) => {
                const imageUrl = publicAssetUrl(product.imagePath)
                const price = currentProductPrice(product)
                return (
                  <article
                    key={product.id}
                    className="group overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm transition duration-200 focus-within:border-[var(--brand)] focus-within:ring-3 focus-within:ring-[var(--brand)]/15 hover:-translate-y-0.5 hover:shadow-lg sm:rounded-3xl"
                  >
                    <button
                      className="grid h-full w-full grid-cols-[minmax(0,1fr)_7rem] text-left disabled:cursor-not-allowed sm:grid-cols-[minmax(0,1fr)_8.5rem]"
                      onClick={() => product.available && setSelectedProduct(product)}
                      disabled={!product.available}
                    >
                      <div className="flex min-h-36 min-w-0 flex-col p-4 sm:min-h-40 sm:p-5">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-display text-lg font-bold leading-tight text-stone-950">{product.name}</h3>
                          {product.featured ? <span className="shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-stone-900" style={{ backgroundColor: 'color-mix(in srgb, var(--brand) 15%, white)', borderColor: 'color-mix(in srgb, var(--brand) 45%, #d6d3d1)' }}>Favorito</span> : null}
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-5 text-stone-600">{product.description}</p>
                        <div className="mt-auto pt-3">
                          <p className="font-display text-base font-bold text-stone-950">{formatMoney(price, restaurant.currencyCode, restaurant.locale)}</p>
                          {price !== product.basePriceCents ? <p className="mt-0.5 text-xs text-stone-400 line-through">{formatMoney(product.basePriceCents, restaurant.currencyCode, restaurant.locale)}</p> : null}
                          {!product.available ? <span className="mt-2 inline-flex rounded-full bg-stone-200 px-2 py-1 text-xs font-bold text-stone-700">Agotado</span> : null}
                        </div>
                      </div>
                      {imageUrl ? (
                        <img loading="lazy" src={imageUrl} alt={product.name} className={`h-full min-h-36 w-full object-cover transition duration-300 sm:min-h-40 ${!product.available ? 'grayscale opacity-60' : 'group-hover:scale-[1.025]'}`} />
                      ) : (
                        <div className="grid min-h-36 place-items-center text-4xl sm:min-h-40" style={{ backgroundColor: 'color-mix(in srgb, var(--brand) 8%, white)' }} role="img" aria-label="Sin imagen">🍲</div>
                      )}
                    </button>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
        {categories.length === 0 ? <p className="rounded-3xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-600 shadow-sm">No hay productos que coincidan con la búsqueda.</p> : null}
      </main>

      {cart.restaurantSlug === restaurant.slug && cart.itemCount > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pt-3 sm:px-4" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <Link
            to={`/r/${restaurant.slug}/carrito`}
            className="pointer-events-auto mx-auto flex min-h-14 max-w-xl items-center justify-between gap-4 rounded-2xl border px-4 font-bold text-white shadow-[0_18px_42px_rgba(12,10,9,.3)] transition hover:-translate-y-0.5 hover:bg-stone-900 sm:px-5"
            style={{ backgroundColor: '#1c1917', borderColor: 'var(--brand)' }}
          >
            <span className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" aria-hidden />Ver carrito · {cart.itemCount}</span>
            <span className="shrink-0">{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</span>
          </Link>
        </div>
      ) : null}
      {selectedProduct ? <ProductDialog product={selectedProduct} restaurant={restaurant} onClose={() => setSelectedProduct(null)} onAdd={(line) => { cart.addLine(line); setSelectedProduct(null) }} /> : null}
    </div>
  )
}
