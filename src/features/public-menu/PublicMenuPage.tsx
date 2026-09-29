import { Search, ShoppingBag, Store, Clock3, MapPin } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { useCart } from '../cart/CartProvider'
import { env } from '../../lib/env'
import { formatMoney, currentProductPrice } from '../../lib/money'
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
  return (
    <div className="min-h-screen bg-[#f7f4ef]" style={{ '--brand': restaurant.primaryColor, '--brand-secondary': restaurant.secondaryColor } as React.CSSProperties}>
      <header className="relative overflow-hidden text-white" style={{backgroundColor:'var(--brand-secondary)'}}>
        {coverUrl ? <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" fetchPriority="high" /> : null}
        <div className="absolute inset-0" style={{background:'linear-gradient(to top, var(--brand-secondary), color-mix(in srgb, var(--brand-secondary) 45%, transparent), transparent)'}} />
        <div className="page-shell relative flex min-h-[310px] flex-col justify-end py-7">
          <div className="flex items-end gap-4">{logoUrl ? <img src={logoUrl} alt={`Logo de ${restaurant.tradeName}`} className="h-24 w-24 rounded-3xl border-4 border-white object-cover shadow-xl" /> : <div className="grid h-24 w-24 place-items-center rounded-3xl border-4 border-white shadow-xl" style={{backgroundColor:'var(--brand)'}}><Store className="h-10 w-10" aria-hidden /></div>}<div className="min-w-0 pb-1"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${restaurant.isOpen ? 'bg-emerald-500 text-emerald-950' : 'bg-amber-300 text-amber-950'}`}>{restaurant.isOpen ? 'Abierto ahora' : 'Cerrado'}</span><h1 className="mt-2 truncate font-display text-3xl font-bold sm:text-4xl">{restaurant.tradeName}</h1></div></div>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-stone-200">{restaurant.description}</p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-stone-300"><span className="flex items-center gap-1.5"><MapPin className="h-4 w-4" aria-hidden />{restaurant.address}, {restaurant.city}</span><span className="flex items-center gap-1.5"><Clock3 className="h-4 w-4" aria-hidden />{restaurant.isOpen ? `Demora estimada: ${restaurant.defaultPreparationMinutes} min` : restaurant.nextOpeningAt ? `Próxima apertura: ${new Date(restaurant.nextOpeningAt).toLocaleString(restaurant.locale, { timeZone: restaurant.timezone })}` : 'Consultá los horarios'}</span></div>
        </div>
      </header>

      <div className="sticky top-0 z-30 border-b border-stone-200 bg-[#f7f4ef]/95 backdrop-blur">
        <div className="page-shell py-3"><label className="relative block"><span className="sr-only">Buscar en el menú</span><Search className="absolute left-3 top-3 h-5 w-5 text-stone-400" aria-hidden /><input className="h-11 w-full rounded-2xl border border-stone-300 bg-white pl-11 pr-4 outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/20" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar platos, bebidas…" /></label><nav className="scrollbar-none mt-3 flex gap-2 overflow-x-auto" aria-label="Categorías">{menuQuery.data.categories.map((category) => <a key={category.id} href={`#category-${category.id}`} className="shrink-0 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold hover:border-[var(--brand)]">{category.name}</a>)}</nav></div>
      </div>

      <main className="page-shell space-y-10 py-8 pb-32">
        {categories.map((category) => <section key={category.id} id={`category-${category.id}`} className="scroll-mt-40"><div className="mb-4"><h2 className="font-display text-2xl font-bold">{category.name}</h2>{category.description ? <p className="mt-1 text-sm text-stone-600">{category.description}</p> : null}</div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{category.products.map((product) => { const imageUrl = publicAssetUrl(product.imagePath); const price = currentProductPrice(product); return <article key={product.id} className="group overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"><button className="grid w-full grid-cols-[1fr_120px] text-left sm:grid-cols-[1fr_140px]" onClick={() => product.available && setSelectedProduct(product)} disabled={!product.available}><div className="flex min-h-40 flex-col p-5"><div className="flex items-start justify-between gap-2"><h3 className="font-display text-lg font-bold leading-tight">{product.name}</h3>{product.featured ? <span className="rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide" style={{backgroundColor:'color-mix(in srgb, var(--brand) 15%, white)',color:'var(--brand)'}}>Favorito</span> : null}</div><p className="mt-2 line-clamp-3 text-sm leading-5 text-stone-600">{product.description}</p><div className="mt-auto pt-4"><p className="font-bold">{formatMoney(price, restaurant.currencyCode, restaurant.locale)}</p>{price !== product.basePriceCents ? <p className="text-xs text-stone-400 line-through">{formatMoney(product.basePriceCents, restaurant.currencyCode, restaurant.locale)}</p> : null}{!product.available ? <span className="mt-2 inline-block rounded-full bg-stone-200 px-2 py-1 text-xs font-bold text-stone-700">Agotado</span> : null}</div></div>{imageUrl ? <img loading="lazy" src={imageUrl} alt={product.name} className={`h-full min-h-40 w-full object-cover ${!product.available ? 'grayscale opacity-60' : ''}`} /> : <div className="grid min-h-40 place-items-center text-4xl" style={{backgroundColor:'color-mix(in srgb, var(--brand) 8%, white)'}} role="img" aria-label="Sin imagen">🍲</div>}</button></article> })}</div></section>)}
        {categories.length === 0 ? <p className="rounded-3xl bg-white p-8 text-center text-stone-600">No hay productos que coincidan con la búsqueda.</p> : null}
      </main>

      {cart.restaurantSlug === restaurant.slug && cart.itemCount > 0 ? <div className="fixed inset-x-0 bottom-0 z-30 p-4"><Link to={`/r/${restaurant.slug}/carrito`} className="mx-auto flex min-h-14 max-w-xl items-center justify-between rounded-2xl px-5 font-bold text-white shadow-2xl" style={{backgroundColor:'var(--brand-secondary)'}}><span className="flex items-center gap-2"><ShoppingBag className="h-5 w-5" aria-hidden />Ver carrito · {cart.itemCount}</span><span>{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</span></Link></div> : null}
      {selectedProduct ? <ProductDialog product={selectedProduct} restaurant={restaurant} onClose={() => setSelectedProduct(null)} onAdd={(line) => { cart.addLine(line); setSelectedProduct(null) }} /> : null}
    </div>
  )
}
