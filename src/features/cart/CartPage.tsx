import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { EmptyState, ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { formatMoney } from '../../lib/money'
import { calculateCartLineTotal } from '../../lib/quantity-pricing'
import { publicAssetUrl } from '../../lib/supabase/client'
import { ProductDialog } from '../public-menu/ProductDialog'
import { usePublicMenu } from '../public-menu/usePublicMenu'
import { useCart } from './CartProvider'
import { validateCartLines } from './cartValidation'

export function CartPage() {
  const { restaurantSlug } = useParams()
  const menu = usePublicMenu(restaurantSlug)
  const cart = useCart()
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const { activateRestaurant, reconcileProducts } = cart
  useEffect(() => { if (restaurantSlug) activateRestaurant(restaurantSlug) }, [activateRestaurant, restaurantSlug])
  useEffect(() => {
    if (!menu.data || cart.restaurantSlug !== menu.data.restaurant.slug) return
    reconcileProducts(menu.data.categories.flatMap(category => category.products))
  }, [cart.restaurantSlug, menu.data, menu.dataUpdatedAt, reconcileProducts])

  if (menu.isLoading) return <LoadingScreen />
  if (!menu.data) return <main className="page-shell py-16"><ErrorPanel>No pudimos cargar el menú para revalidar el carrito.</ErrorPanel></main>
  const restaurant = menu.data.restaurant
  if (cart.restaurantSlug !== restaurant.slug) return <LoadingScreen label="Recuperando tu carrito…" />
  const products = menu.data.categories.flatMap(category => category.products)
  const issues = validateCartLines(cart.lines, products)
  const invalid = [...issues.values()].some(lineIssues => lineIssues.length > 0)
  const canContinue = !invalid && !menu.isFetching && !menu.error && restaurant.isOpen && cart.subtotalCents >= restaurant.minimumOrderCents && cart.itemCount <= 100 && cart.lines.length <= 25
  const editingLine = cart.lines.find(line => line.key === editingKey)
  const editingProduct = products.find(product => product.id === editingLine?.productId)

  return <main className="min-h-screen bg-stone-100 py-6 sm:py-10"><div className="page-shell max-w-4xl">
    <Link to={`/r/${restaurant.slug}`} className="inline-flex items-center gap-2 text-sm font-semibold text-stone-600"><ArrowLeft className="h-4 w-4" aria-hidden />Volver al menú</Link>
    <h1 className="mt-5 font-display text-4xl font-bold">Tu pedido</h1>
    <p className="mt-2 text-stone-600">Revisá cantidades y observaciones. Los precios se actualizan con el menú y se validan nuevamente al confirmar.</p>
    {menu.isFetching ? <p className="mt-3 text-sm" role="status">Actualizando precios y disponibilidad…</p> : null}
    {menu.error ? <p className="form-error mt-3" role="alert">No pudimos actualizar el menú. <button type="button" className="underline" onClick={() => void menu.refetch()}>Volver a intentar</button></p> : null}
    {cart.lines.length === 0 ? <div className="mt-8"><EmptyState title="El carrito está vacío" description="Elegí algo rico del menú para empezar." action={<Link className="button-primary" to={`/r/${restaurant.slug}`}>Explorar menú</Link>} /></div> : <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_310px]">
      <section className="space-y-3" aria-label="Productos en el carrito">{cart.lines.map(line => {
        const imageUrl = publicAssetUrl(line.productImagePath)
        const product = products.find(row => row.id === line.productId)
        const lineIssues = issues.get(line.key) ?? []
        return <article key={line.key} aria-label={line.productName} className={`flex gap-4 rounded-3xl border bg-white p-4 ${lineIssues.length ? 'border-amber-400' : 'border-stone-200'}`}>
          {imageUrl ? <img src={imageUrl} alt="" className="h-24 w-24 rounded-2xl object-cover" /> : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2"><div><h2 className="font-display font-bold">{line.productName}</h2>{line.selectedOptions.length > 0 ? <p className="mt-1 text-xs leading-5 text-stone-500">{line.selectedOptions.map(option => option.name).join(' · ')}</p> : null}{line.notes ? <p className="mt-1 text-xs italic text-stone-500">“{line.notes}”</p> : null}</div><button className="icon-button text-red-700" onClick={() => cart.removeLine(line.key)} aria-label={`Quitar ${line.productName}`}><Trash2 className="h-4 w-4" aria-hidden /></button></div>
            {lineIssues.length ? <ul className="mt-3 space-y-1 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{lineIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul> : null}
            {product?.available ? <button className="mt-3 text-sm font-semibold underline" type="button" onClick={() => setEditingKey(line.key)}>Reconfigurar {line.productName}</button> : null}
            <div className="mt-4 flex items-center justify-between"><div className="flex items-center rounded-xl border border-stone-300"><button className="quantity-button-small" onClick={() => cart.updateQuantity(line.key, line.quantity - 1)} aria-label={`Restar ${line.productName}`}><Minus aria-hidden /></button><span className="w-8 text-center text-sm font-bold">{line.quantity}</span><button className="quantity-button-small" onClick={() => cart.updateQuantity(line.key, line.quantity + 1)} aria-label={`Sumar ${line.productName}`}><Plus aria-hidden /></button></div><p className="font-bold">{formatMoney(calculateCartLineTotal(line), restaurant.currencyCode, restaurant.locale)}</p></div>
          </div>
        </article>
      })}</section>
      <aside className="h-fit rounded-3xl bg-stone-950 p-5 text-white lg:sticky lg:top-6">
        <h2 className="font-display text-xl font-bold">Resumen</h2><div className="mt-5 flex justify-between text-sm text-stone-300"><span>Subtotal estimado</span><strong className="text-white">{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</strong></div>
        <p className="mt-3 text-xs leading-5 text-stone-400">El descuento, recargo y envío se calculan en el checkout. El servidor confirma el total definitivo.</p>
        {invalid ? <p className="mt-4 rounded-xl bg-amber-300 p-3 text-xs font-semibold text-amber-950">Revisá los productos marcados antes de continuar. Conservamos tus notas y opciones.</p> : null}
        {cart.subtotalCents < restaurant.minimumOrderCents ? <p className="mt-4 rounded-xl bg-amber-300 p-3 text-xs font-semibold text-amber-950">Faltan {formatMoney(restaurant.minimumOrderCents - cart.subtotalCents, restaurant.currencyCode, restaurant.locale)} para el mínimo del comercio.</p> : null}
        {cart.itemCount > 100 || cart.lines.length > 25 ? <p className="mt-4 rounded-xl bg-red-200 p-3 text-xs font-semibold text-red-950">El pedido admite hasta 25 renglones y 100 unidades. Ajustá el carrito para continuar.</p> : null}
        {canContinue ? <Link className="mt-5 flex min-h-12 items-center justify-center rounded-xl bg-orange-600 font-bold hover:bg-orange-500" to={`/r/${restaurant.slug}/checkout`}>Continuar</Link> : <button type="button" disabled className="mt-5 flex min-h-12 w-full items-center justify-center rounded-xl bg-stone-700 font-bold text-stone-400">Continuar</button>}
        {!restaurant.isOpen ? <p className="mt-3 text-center text-xs text-amber-300">El comercio está cerrado. Podés conservar el carrito para más tarde.</p> : null}
      </aside>
    </div>}
  </div>{editingLine && editingProduct ? <ProductDialog key={editingLine.key} product={editingProduct} restaurant={restaurant} initialLine={editingLine} onClose={() => setEditingKey(null)} onAdd={line => { cart.replaceLine(editingLine.key, line); setEditingKey(null) }} /> : null}</main>
}
