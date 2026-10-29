import { ArrowLeft, Minus, Package, Plus, Trash2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { EmptyState, ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { formatMoney } from '../../lib/money'
import { calculateCartLineTotal } from '../../lib/quantity-pricing'
import { responsiveAssetUrls } from '../../lib/images/responsive'
import { queryKeys } from '../../lib/queryKeys'
import { fetchPublicCatalogGroup } from '../public-menu/api'
import { ProductDialog } from '../public-menu/ProductDialog'
import { usePublicMenu } from '../public-menu/usePublicMenu'
import { useCart } from './CartProvider'
import { validateCartLines } from './cartValidation'
import { commercePath, useCommerceChannel } from '../../lib/commerce-channel'
import { StorePurchaseSteps } from '../store/StorePurchaseSteps'

export function CartPage() {
  const { restaurantSlug } = useParams()
  const channel = useCommerceChannel()
  const cart = useCart()
  const menu = usePublicMenu(restaurantSlug, channel, cart.lines.map((line) => line.productId))
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const { activateRestaurant, reconcileProducts } = cart
  const products = menu.data?.categories.flatMap(category => category.products) ?? []
  const editingLine = cart.lines.find(line => line.key === editingKey)
  const editingProduct = products.find(product => product.id === editingLine?.productId)
  const editingGroupId = editingProduct?.family?.id ?? editingProduct?.id
  const editingGroup = useQuery({
    queryKey: queryKeys.publicCatalog.group(restaurantSlug, channel, editingGroupId),
    queryFn: () => fetchPublicCatalogGroup(restaurantSlug ?? '', editingGroupId ?? '', channel),
    enabled: Boolean(restaurantSlug && editingKey && editingGroupId),
    retry: 1,
  })
  useEffect(() => { if (restaurantSlug) activateRestaurant(restaurantSlug, channel) }, [activateRestaurant, restaurantSlug, channel])
  useEffect(() => {
    if (!menu.data || cart.restaurantSlug !== menu.data.restaurant.slug || (cart.channel ?? 'menu') !== channel) return
    reconcileProducts(menu.data.categories.flatMap(category => category.products))
  }, [cart.restaurantSlug, cart.channel, channel, menu.data, menu.dataUpdatedAt, reconcileProducts])

  if (menu.isLoading) return <LoadingScreen />
  if (!menu.data) return <main className="page-shell py-16"><ErrorPanel>No pudimos cargar el catálogo para actualizar tu carrito.</ErrorPanel></main>
  const restaurant = menu.data.restaurant
  if (cart.restaurantSlug !== restaurant.slug || (cart.channel ?? 'menu') !== channel) return <LoadingScreen label="Recuperando tu carrito…" />
  const issues = validateCartLines(cart.lines, products)
  const invalid = [...issues.values()].some(lineIssues => lineIssues.length > 0)
  const acceptsOrders = restaurant.acceptsOrders ?? restaurant.isOpen
  const canContinue = !invalid && !menu.isFetching && !menu.refreshError && acceptsOrders && cart.subtotalCents >= restaurant.minimumOrderCents && cart.itemCount <= 100 && cart.lines.length <= 25
  const editingVariants = editingGroup.data?.group.variants ?? []
  const dialogProduct = editingVariants.find(product => product.id === editingLine?.productId) ?? editingProduct

  return <main className={`min-h-screen py-6 sm:py-10 ${channel === 'store' ? 'bg-[#f7f5f2]' : 'bg-stone-100'}`}><div className="page-shell max-w-4xl">
    <Link to={commercePath(restaurant.slug, channel)} className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-stone-600"><ArrowLeft className="h-4 w-4" aria-hidden />Volver {channel === 'store' ? 'a la tienda' : 'al menú'}</Link>
    {channel === 'store' ? <StorePurchaseSteps slug={restaurant.slug} current={1} /> : null}
    <h1 className="mt-5 font-display text-3xl font-bold tracking-tight sm:text-4xl">{channel === 'store' ? 'Tu carrito' : 'Tu pedido'}</h1>
    <p className="mt-2 text-sm leading-6 text-stone-600">{channel === 'store' ? 'Revisá el producto, la variante y la cantidad. En el siguiente paso elegís cómo recibir y pagar tu compra.' : 'Revisá cantidades y observaciones. Los precios se actualizan con el menú y se validan nuevamente al confirmar.'}</p>
    {menu.isFetching ? <p className="mt-3 text-sm" role="status">Actualizando precios y disponibilidad…</p> : null}
    {menu.refreshError ? <p className="form-error mt-3" role="alert">No pudimos actualizar el catálogo. <button type="button" className="underline" onClick={() => void menu.refresh()}>Volver a intentar</button></p> : null}
    {editingKey && editingGroup.isLoading ? <p className="mt-3 text-sm" role="status">Cargando variantes disponibles…</p> : null}
    {editingKey && editingGroup.error ? <p className="form-error mt-3" role="alert">No pudimos cargar las variantes. <button type="button" className="underline" onClick={() => void editingGroup.refetch()}>Volver a intentar</button></p> : null}
    {cart.lines.length === 0 ? <div className="mt-8"><EmptyState title="El carrito está vacío" description="Elegí productos del catálogo para empezar." action={<Link className="button-primary" to={commercePath(restaurant.slug, channel)}>Explorar catálogo</Link>} /></div> : <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_310px]">
      <section className="space-y-3" aria-label="Productos en el carrito">{cart.lines.map(line => {
        const image = responsiveAssetUrls(line.productImagePath)
        const product = products.find(row => row.id === line.productId)
        const lineIssues = issues.get(line.key) ?? []
        return <article key={line.key} aria-label={line.productName} className={`flex gap-4 rounded-3xl border bg-white p-4 ${lineIssues.length ? 'border-amber-400' : 'border-stone-200'}`}>
          {image.src ? <img src={image.src} srcSet={image.srcSet} sizes="96px" loading="lazy" decoding="async" alt="" className="h-16 w-16 shrink-0 rounded-2xl object-contain sm:h-24 sm:w-24" /> : channel === 'store' ? <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-stone-100 sm:h-24 sm:w-24"><Package className="h-7 w-7 text-stone-400" aria-hidden /></div> : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2"><div><h2 className="font-display font-bold">{line.productName}</h2>{line.selectedOptions.length > 0 ? <p className="mt-1 text-xs leading-5 text-stone-500">{line.selectedOptions.map(option => option.name).join(' · ')}</p> : null}{line.notes ? <p className="mt-1 text-xs italic text-stone-500">“{line.notes}”</p> : null}</div><button className="icon-button text-red-700" onClick={() => cart.removeLine(line.key)} aria-label={`Quitar ${line.productName}`}><Trash2 className="h-4 w-4" aria-hidden /></button></div>
            {lineIssues.length ? <ul className="mt-3 space-y-1 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{lineIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul> : null}
            {product && (product.available || product.family) ? <button className="mt-2 min-h-11 text-left text-sm font-semibold underline decoration-stone-300 underline-offset-4" type="button" aria-label={`${channel === 'store' ? 'Editar' : 'Reconfigurar'} ${line.productName}`} onClick={() => setEditingKey(line.key)}>{channel === 'store' ? product.family ? 'Cambiar variante y detalles' : 'Editar detalles' : `Reconfigurar ${line.productName}`}</button> : null}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center rounded-xl border border-stone-300"><button className="quantity-button-small h-11 w-11" onClick={() => cart.updateQuantity(line.key, line.quantity - 1)} aria-label={`Restar ${line.productName}`}><Minus aria-hidden /></button><span className="w-8 text-center text-sm font-bold" aria-live="polite">{line.quantity}</span><button className="quantity-button-small h-11 w-11" onClick={() => cart.updateQuantity(line.key, line.quantity + 1)} aria-label={`Sumar ${line.productName}`}><Plus aria-hidden /></button></div><p className="font-bold">{formatMoney(calculateCartLineTotal(line), restaurant.currencyCode, restaurant.locale)}</p></div>
          </div>
        </article>
      })}</section>
      <aside className="h-fit rounded-3xl bg-stone-950 p-5 text-white lg:sticky lg:top-6">
        <h2 className="font-display text-xl font-bold">Resumen</h2><div className="mt-5 flex justify-between text-sm text-stone-300"><span>Subtotal estimado</span><strong className="text-white">{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</strong></div>
        <p className="mt-3 text-xs leading-5 text-stone-300">El envío y los ajustes por medio de pago se muestran en el siguiente paso, antes de confirmar.</p>
        {invalid ? <p className="mt-4 rounded-xl bg-amber-300 p-3 text-xs font-semibold text-amber-950">Revisá los productos marcados antes de continuar. Conservamos tus notas y opciones.</p> : null}
        {cart.subtotalCents < restaurant.minimumOrderCents ? <p className="mt-4 rounded-xl bg-amber-300 p-3 text-xs font-semibold text-amber-950">Faltan {formatMoney(restaurant.minimumOrderCents - cart.subtotalCents, restaurant.currencyCode, restaurant.locale)} para el mínimo del comercio.</p> : null}
        {cart.itemCount > 100 || cart.lines.length > 25 ? <p className="mt-4 rounded-xl bg-red-200 p-3 text-xs font-semibold text-red-950">El pedido admite hasta 25 renglones y 100 unidades. Ajustá el carrito para continuar.</p> : null}
        {canContinue ? <Link className="mt-5 flex min-h-12 items-center justify-center rounded-xl bg-orange-600 font-bold hover:bg-orange-500" to={commercePath(restaurant.slug, channel, '/checkout')}>Continuar</Link> : <button type="button" disabled className="mt-5 flex min-h-12 w-full items-center justify-center rounded-xl bg-stone-700 font-bold text-stone-400">Continuar</button>}
        {!acceptsOrders ? <p className="mt-3 text-center text-xs text-amber-300">{channel === 'store' ? 'La tienda no recibe compras en este momento.' : 'El comercio está cerrado.'} Podés conservar el carrito para más tarde.</p> : null}
      </aside>
    </div>}
  </div>{editingLine && dialogProduct && editingVariants.length ? <ProductDialog key={editingLine.key} product={dialogProduct} variants={editingVariants} restaurant={restaurant} initialLine={editingLine} onClose={() => setEditingKey(null)} onAdd={line => { cart.replaceLine(editingLine.key, line); setEditingKey(null) }} /> : null}</main>
}
