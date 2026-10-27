import { ArrowLeft, Clock3, Package, Search, ShoppingBag, Store } from 'lucide-react'
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

export function PublicStorePage() {
  const { restaurantSlug, productId } = useParams()
  const query = usePublicMenu(restaurantSlug, 'store')
  const cart = useCart()
  const { activateRestaurant, reconcileProducts } = cart
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [selected, setSelected] = useState<PublicProduct | null>(null)
  const [showHours, setShowHours] = useState(false)
  useEffect(() => { if (restaurantSlug) activateRestaurant(restaurantSlug, 'store') }, [restaurantSlug, activateRestaurant])
  useEffect(() => {
    if (query.data && cart.restaurantSlug === restaurantSlug && cart.channel === 'store') reconcileProducts(query.data.categories.flatMap(category => category.products))
  }, [query.data, query.dataUpdatedAt, cart.restaurantSlug, cart.channel, restaurantSlug, reconcileProducts])
  if (query.isLoading) return <LoadingScreen label="Preparando la tienda…" />
  if (!query.data) return <main className="page-shell py-16"><ErrorPanel title="Tienda no disponible">No encontramos una tienda publicada con esta dirección.<button className="button-secondary mt-4" onClick={() => void query.refetch()}>Reintentar</button></ErrorPanel></main>
  const { restaurant, categories } = query.data
  const products = categories.flatMap(category => category.products)
  const detail = productId ? products.find(product => product.id === productId || product.family?.id === productId) : null
  const phrase = search.trim().toLocaleLowerCase('es')
  const visible = groupCatalogProducts(products.filter(product => (!categoryId || product.categoryId === categoryId) && `${product.family?.name ?? ''} ${product.name} ${product.description} ${product.code} ${variantLabel(product)}`.toLocaleLowerCase('es').includes(phrase)))
  const cover = publicAssetUrl(restaurant.coverPath)
  const logo = publicAssetUrl(restaurant.logoPath)
  const money = (amount: number) => formatMoney(amount, restaurant.currencyCode, restaurant.locale)
  const acceptsOrders = restaurant.acceptsOrders ?? restaurant.isOpen
  const recovery = readPaymentRecovery(restaurant.slug)
  return <div className="min-h-screen bg-stone-50" style={{ '--brand': restaurant.primaryColor } as CSSProperties}>
    <header className="border-b border-stone-200 bg-white">
      {cover ? <div className="h-36 overflow-hidden sm:h-56"><img className="h-full w-full object-cover" src={cover} alt="" /></div> : null}
      <div className="page-shell flex items-center justify-between gap-4 py-6"><Link to={commercePath(restaurant.slug, 'store')} className="flex min-w-0 items-center gap-3">{logo ? <img src={logo} alt="" className="h-16 w-16 rounded-2xl object-cover" /> : <Store className="h-12 w-12" aria-hidden />}<div><p className="text-xs font-bold uppercase tracking-widest text-stone-500">Tienda online</p><h1 className="font-display text-2xl font-bold sm:text-3xl">{restaurant.tradeName}</h1></div></Link><Link to={commercePath(restaurant.slug, 'store', '/carrito')} className="button-secondary" aria-label={`Ver carrito, ${cart.channel === 'store' ? cart.itemCount : 0} productos`}><ShoppingBag className="h-5 w-5" aria-hidden /><span>{cart.channel === 'store' ? cart.itemCount : 0}</span></Link></div>
      <div className="page-shell pb-5"><p className="max-w-3xl text-sm text-stone-600">{restaurant.description}</p><div className="mt-3 flex flex-wrap items-center gap-3 text-xs"><span className={`rounded-full px-3 py-1 font-semibold ${acceptsOrders ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>{acceptsOrders ? 'Recibimos pedidos' : 'Pedidos pausados'}</span><button className="flex min-h-8 items-center gap-1.5 underline" onClick={() => setShowHours(true)}><Clock3 className="h-4 w-4" />Atención: {restaurant.isOpen ? 'abierto ahora' : 'fuera de horario'}</button><span>{restaurant.pickupEnabled ? 'Retiro en el local' : ''}{restaurant.pickupEnabled && restaurant.deliveryEnabled ? ' · ' : ''}{restaurant.deliveryEnabled ? 'Envíos locales' : ''}</span></div>{recovery ? <Link className="mt-3 inline-block text-sm font-semibold underline" to={commercePath(restaurant.slug, 'store', '/pago')}>Consultar mi última compra</Link> : null}</div>
    </header>
    <main className="page-shell py-7 pb-28">
      {productId ? detail ? <section><Link className="inline-flex items-center gap-2 text-sm font-semibold underline" to={commercePath(restaurant.slug, 'store')}><ArrowLeft className="h-4 w-4" />Todos los productos</Link><div className="mt-6 grid gap-8 md:grid-cols-2"><div className="grid aspect-square place-items-center overflow-hidden rounded-3xl bg-white">{publicAssetUrl(detail.family?.imagePath ?? detail.imagePath) ? <img src={publicAssetUrl(detail.family?.imagePath ?? detail.imagePath)!} alt={detail.family?.name ?? detail.name} className="h-full w-full object-contain" /> : <Package className="h-24 w-24 text-stone-200" />}</div><div className="py-4"><h2 className="font-display text-3xl font-bold">{detail.family?.name ?? detail.name}</h2><p className="mt-4 whitespace-pre-line leading-7 text-stone-600">{detail.family?.description ?? detail.description}</p><p className="mt-5 text-2xl font-bold">{detail.family ? 'Desde ' : ''}{money(Math.min(...productVariants(detail, products).map(variant => currentProductPrice(variant))))}</p>{detail.family ? <p className="mt-3 text-sm text-stone-500">{productVariants(detail, products).length} variantes · {detail.family.axes.join(', ')}</p> : null}<button className="button-primary mt-7 min-h-12" disabled={!productVariants(detail, products).some(variant => variant.available) || !acceptsOrders} onClick={() => setSelected(productVariants(detail, products).find(variant => variant.available) ?? detail)}>{detail.family ? 'Elegir variante' : 'Agregar al carrito'}</button></div></div></section> : <ErrorPanel title="Producto no disponible">Este producto ya no está en el catálogo. <Link className="underline" to={commercePath(restaurant.slug, 'store')}>Volver a la tienda</Link></ErrorPanel> : <>
        <div className="mb-7 flex flex-col gap-3 sm:flex-row"><label className="relative flex-1"><span className="sr-only">Buscar productos</span><Search className="absolute left-4 top-3.5 h-5 w-5 text-stone-400" /><input className="h-12 w-full rounded-2xl border border-stone-300 bg-white pl-12 pr-4" placeholder="Buscar productos, modelos, colores…" value={search} onChange={event => setSearch(event.target.value)} /></label><label><span className="sr-only">Categoría</span><select className="h-12 w-full rounded-2xl border border-stone-300 bg-white px-4 sm:min-w-52" value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">Todas las categorías</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label></div>
        <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">{visible.map(product => {
          const variants = productVariants(product, products)
          const price = Math.min(...variants.map(variant => currentProductPrice(variant)))
          const url = publicAssetUrl(product.family?.imagePath ?? product.imagePath)
          return <article key={product.family?.id ?? product.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white transition hover:shadow-lg"><Link to={commercePath(restaurant.slug, 'store', `/producto/${product.family?.id ?? product.id}`)}><div className="grid aspect-square place-items-center bg-stone-100">{url ? <img src={url} alt={product.family?.name ?? product.name} loading="lazy" className="h-full w-full object-cover" /> : <Package className="h-14 w-14 text-stone-300" />}</div><div className="p-4"><h2 className="font-semibold leading-snug">{product.family?.name ?? product.name}</h2><p className="mt-2 font-bold">{product.family ? 'Desde ' : ''}{money(price)}</p><p className="mt-2 text-xs text-stone-500">{variants.some(variant => variant.available) ? product.family ? `${variants.length} variantes` : 'Disponible' : 'Agotado'}</p></div></Link></article>
        })}</div>{visible.length === 0 ? <p className="py-14 text-center text-stone-500">No encontramos productos para esta búsqueda.</p> : null}
      </>}
    </main>
    {cart.channel === 'store' && cart.restaurantSlug === restaurant.slug && cart.itemCount > 0 ? <div className="fixed inset-x-0 bottom-0 z-30 p-4"><Link className="mx-auto flex max-w-xl items-center justify-between rounded-2xl bg-stone-950 p-4 font-bold text-white shadow-xl" to={commercePath(restaurant.slug, 'store', '/carrito')}><span>Ver carrito · {cart.itemCount}</span><span>{money(cart.subtotalCents)}</span></Link></div> : null}
    {selected ? <ProductDialog product={selected} variants={productVariants(selected, products)} restaurant={restaurant} onClose={() => setSelected(null)} onAdd={line => { cart.addLine(line); setSelected(null) }} /> : null}
    {showHours ? <RestaurantHoursDialog restaurantName={restaurant.tradeName} timeZone={restaurant.timezone} locale={restaurant.locale} businessHours={query.data.businessHours} specialHours={query.data.specialHours} onClose={() => setShowHours(false)} /> : null}
  </div>
}
