import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { adminOrderSchema, eventSchema, itemOptionSchema, itemSchema } from './orderSchemas'
import { StatusPill } from './OrderStatus'
import { clearReverseAttempt, inventoryDetailSchema, inventoryOrderError, inventoryOutcomeLabel, isReversed, loadReverseAttempt, saveReverseAttempt, type ReverseAttempt } from './inventoryOrder'

export function OrderDetailPage() {
  const { orderId } = useParams()
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const [cancelReason, setCancelReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [received, setReceived] = useState(false)
  const [reverseKind, setReverseKind] = useState<'correction' | 'return'>('return')
  const [reverseReason, setReverseReason] = useState('')
  const [restock, setRestock] = useState<'' | 'yes' | 'no' | 'partial'>('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [reverseConfirmed, setReverseConfirmed] = useState(false)
  const [pendingReverse, setPendingReverse] = useState<ReverseAttempt | null>(null)
  const [replacementSearch, setReplacementSearch] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [replacementReason, setReplacementReason] = useState('')
  const isAdmin = scope.selected?.role === 'restaurant_admin' || scope.selected?.role === 'super_admin'

  useEffect(() => {
    setReceived(false)
    setPendingReverse(null)
    setError(null)
    if (!orderId) return
    try {
      const attempt = loadReverseAttempt(orderId)
      if (attempt) {
        setPendingReverse(attempt)
        setReverseKind(attempt.kind)
        setReverseReason(attempt.reason)
        setRestock(attempt.quantities ? 'partial' : attempt.restock ? 'yes' : 'no')
        setQuantities(Object.fromEntries((attempt.quantities ?? []).map((item) => [item.productId, String(item.quantity)])))
      }
    } catch { setError('No pudimos leer el intento anterior. Revisá la línea de tiempo antes de iniciar otra corrección.') }
  }, [orderId])
  const query = useQuery({
    queryKey: ['order-detail', scope.selected?.id, orderId],
    enabled: Boolean(scope.selected) && z.string().uuid().safeParse(orderId).success,
    queryFn: async () => {
      const restaurantId = scope.selected?.id ?? ''
      const orderResult = await supabase
        .from('orders')
        .select('*')
        .eq('id', orderId ?? '')
        .eq('restaurant_id', restaurantId)
        .single()
      if (orderResult.error) throw new Error('No se pudo cargar el pedido.')
      const order = adminOrderSchema.parse(orderResult.data)
      const [itemsResult, eventsResult] = await Promise.all([
        supabase.from('order_items').select('*').eq('order_id', order.id).eq('restaurant_id', restaurantId).order('created_at'),
        supabase.from('order_events').select('*').eq('order_id', order.id).eq('restaurant_id', restaurantId).order('created_at'),
      ])
      if (itemsResult.error || eventsResult.error) throw new Error('No se pudo cargar el pedido.')
      const items = z.array(itemSchema).parse(itemsResult.data)
      let options: z.infer<typeof itemOptionSchema>[] = []
      if (items.length > 0) {
        const optionsResult = await supabase
          .from('order_item_options')
          .select('*')
          .eq('restaurant_id', restaurantId)
          .in('order_item_id', items.map((item) => item.id))
          .order('created_at')
        if (optionsResult.error) throw new Error('No se pudo cargar el pedido.')
        options = z.array(itemOptionSchema).parse(optionsResult.data)
      }
      let inventory: z.infer<typeof inventoryDetailSchema> = { replacementOrderId: null, inventoryOperations: [] }
      if (order.inventory_tracked || isReversed(order) || order.replaces_order_id) {
        const details = await supabase.rpc('get_order_by_action', { p_action_id: order.action_id })
        if (details.error) throw new Error('No se pudo cargar el historial de inventario del pedido.')
        inventory = inventoryDetailSchema.parse(details.data)
      }
      return { order, items, options, events: z.array(eventSchema).parse(eventsResult.data), inventory }
    },
  })
  const replacements = useQuery({
    queryKey: ['order-replacements', scope.selected?.id, orderId, replacementSearch],
    enabled: Boolean(isAdmin && query.data && isReversed(query.data.order) && !query.data.inventory.replacementOrderId),
    queryFn: async () => {
      let request = supabase.from('orders').select('id,display_number,customer_name').eq('restaurant_id', scope.selected?.id ?? '').in('status', ['generated', 'whatsapp_opened']).is('replaces_order_id', null).order('created_at', { ascending: false }).limit(25)
      const search = replacementSearch.trim().replace(/[%_]/g, '')
      if (search) request = request.ilike('display_number', `%${search}%`)
      const { data, error: loadError } = await request
      if (loadError) throw new Error('No se pudieron consultar los pedidos pendientes.')
      return z.array(z.object({ id: z.string().uuid(), display_number: z.string(), customer_name: z.string() })).parse(data)
    },
  })

  if (query.isLoading) return <LoadingScreen />
  if (query.error || !query.data) {
    return <ErrorPanel>{query.error?.message ?? 'Pedido inexistente o sin acceso.'}</ErrorPanel>
  }

  const { order, items, options, events, inventory } = query.data
  const deliveredProducts = new Map<string, { name: string; quantity: number }>()
  for (const item of items) {
    if (item.product_id) deliveredProducts.set(item.product_id, { name: item.product_name_snapshot, quantity: (deliveredProducts.get(item.product_id)?.quantity ?? 0) + item.quantity })
  }

  async function refreshOrder() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['order-detail', order.restaurant_id, order.id] }),
      client.invalidateQueries({ queryKey: ['orders', order.restaurant_id] }),
      client.invalidateQueries({ queryKey: ['dashboard-orders', order.restaurant_id] }),
      client.invalidateQueries({ queryKey: ['inventory', order.restaurant_id] }),
      client.invalidateQueries({ queryKey: ['claim-order', order.action_id] }),
    ])
  }

  async function mutate(name: 'complete_order' | 'cancel_order') {
    if (running.current) return
    setError(null)
    if (order.restaurant_id !== scope.selected?.id) {
      setError('El pedido no pertenece al restaurante seleccionado.')
      return
    }
    const args = name === 'complete_order'
      ? { p_order_id: order.id }
      : { p_order_id: order.id, p_reason: cancelReason.trim() }
    if (name === 'cancel_order' && cancelReason.trim().length < 3) {
      setError('Ingresá un motivo de cancelación.')
      return
    }
    if (name === 'complete_order' && !received) { setError('Confirmá primero que el cliente recibió o retiró todo el pedido.'); return }
    running.current = true
    setBusy(true)
    try {
      const { error: rpcError } = await supabase.rpc(name, args)
      if (rpcError) throw rpcError
    } catch (failure) { setError(inventoryOrderError(failure)) }
    finally { await refreshOrder(); running.current = false; setBusy(false) }
  }

  async function reverse() {
    if (running.current || !isAdmin || scope.selected?.id !== order.restaurant_id) return
    setError(null)
    if (!reverseConfirmed || reverseReason.trim().length < 3 || !restock || (reverseKind === 'correction' && restock !== 'yes')) { setError('Indicá el motivo, el destino de la mercadería y confirmá la operación completa.'); return }
    let parts: { productId: string; quantity: number }[] | undefined
    if (restock === 'partial') {
      parts = [...deliveredProducts].map(([productId]) => ({ productId, quantity: Number(quantities[productId]) }))
      if (!parts.length || parts.some((item) => !quantities[item.productId]?.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 0 || item.quantity > (deliveredProducts.get(item.productId)?.quantity ?? 0))) { setError('Ingresá las unidades vendibles de cada producto, entre cero y la cantidad entregada.'); return }
    }
    running.current = true
    setBusy(true)
    try {
      const attempt = pendingReverse ?? { operationId: crypto.randomUUID(), kind: reverseKind, restock: restock !== 'no', reason: reverseReason.trim(), ...(parts ? { quantities: parts } : {}) }
      saveReverseAttempt(order.id, attempt)
      setPendingReverse(attempt)
      const response = await supabase.rpc('reverse_order_inventory', { p_order_id: order.id, p_operation_id: attempt.operationId, p_kind: attempt.kind, p_restock: attempt.restock, p_reason: attempt.reason, ...(attempt.quantities ? { p_restock_quantities: attempt.quantities } : {}) })
      if (response.error) throw response.error
      const result = z.object({ operationId: z.string().uuid(), orderId: z.string().uuid() }).parse(response.data)
      if (result.operationId !== attempt.operationId || result.orderId !== order.id) throw new Error('Invalid operation response')
      clearReverseAttempt(order.id)
      setPendingReverse(null)
    } catch (failure) { setError(inventoryOrderError(failure)) }
    finally { await refreshOrder(); running.current = false; setBusy(false) }
  }

  async function linkReplacement() {
    if (running.current || !isAdmin || scope.selected?.id !== order.restaurant_id) return
    if (!replacementId || replacementReason.trim().length < 3) { setError('Seleccioná el pedido pendiente y explicá por qué reemplaza al original.'); return }
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await supabase.rpc('link_order_replacement', { p_original_order_id: order.id, p_replacement_order_id: replacementId, p_reason: replacementReason.trim() })
      if (response.error) throw response.error
    } catch (failure) { setError(inventoryOrderError(failure)) }
    finally { await refreshOrder(); running.current = false; setBusy(false) }
  }

  const deliveryAddress = [
    order.delivery_address,
    order.delivery_neighborhood,
    order.delivery_city,
  ].filter(Boolean).join(', ')

  return <>
    <PageHeader
      eyebrow="Detalle"
      title={order.display_number}
      description={`Creado ${new Date(order.created_at).toLocaleString('es-AR')}`}
      actions={<Link className="button-secondary" to="/admin/pedidos"><ArrowLeft className="h-4 w-4" />Volver</Link>}
    />
    {error ? <p className="form-error mb-5" role="alert">{error}</p> : null}
    {order.inventory_tracked || order.replaces_order_id || isReversed(order) ? <section className="form-card mb-6">
      <h2 className="form-card-title">Entrega e inventario</h2>
      <p className="mt-3">{isReversed(order) ? inventoryOutcomeLabel[order.inventory_outcome] : order.status === 'accepted' ? 'Unidades reservadas. Pendiente de recepción del cliente o retiro.' : order.inventory_outcome === 'delivered' ? 'Entrega vigente: existencia física descontada.' : 'La reserva se realiza al aceptar; la existencia física se descuenta al confirmar recepción o retiro.'}</p>
      {isReversed(order) ? <p className="mt-2 text-sm">Se conserva el pedido original. Su importe no se suma como venta vigente. Esto no registra un reintegro de dinero.</p> : null}
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        {order.replaces_order_id?<Link className="underline" to={`/admin/pedidos/${order.replaces_order_id}`}>Ver pedido reemplazado</Link>:null}
        {order.root_order_id && order.root_order_id !== order.id && order.root_order_id !== order.replaces_order_id?<Link className="underline" to={`/admin/pedidos/${order.root_order_id}`}>Ver pedido original de la operación</Link>:null}
        {inventory.replacementOrderId?<Link className="underline" to={`/admin/pedidos/${inventory.replacementOrderId}`}>Ver pedido de reemplazo</Link>:null}
      </div>
      {order.replacement_reason?<p className="mt-3 text-sm">Motivo del reemplazo: {order.replacement_reason}</p>:null}
    </section>:null}
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-6">
        <section className="form-card">
          <div className="flex justify-between"><h2 className="form-card-title">Productos</h2><StatusPill status={order.status} outcome={order.inventory_outcome} /></div>
          <div className="mt-5 divide-y divide-stone-200">
            {items.map((item) => <article className="py-4 first:pt-0" key={item.id}>
              <div className="flex justify-between gap-3">
                <div><strong>{item.quantity} × {item.product_name_snapshot}</strong><p className="text-xs text-stone-500">{item.product_code_snapshot}</p></div>
                <strong>{formatMoney(item.line_total_cents, order.currency_code)}</strong>
              </div>
              {options.filter((option) => option.order_item_id === item.id).map((option) => <p key={option.id} className="mt-1 pl-4 text-sm text-stone-600">· {option.group_name_snapshot}: {option.option_name_snapshot}{Number(option.price_delta_cents) ? ` (+${formatMoney(option.price_delta_cents, order.currency_code)})` : ''}</p>)}
              {item.pricing_mode_snapshot === 'quantity' ? <p className="mt-1 text-xs font-semibold text-emerald-700">Promo por cantidad aplicada · base {formatMoney(item.base_subtotal_cents, order.currency_code)}</p> : null}
              {item.notes ? <p className="mt-2 text-sm italic text-stone-500">“{item.notes}”</p> : null}
            </article>)}
          </div>
          <dl className="mt-5 space-y-2 border-t border-stone-200 pt-4 text-sm">
            <Total label="Subtotal" value={order.subtotal_cents} currency={order.currency_code} />
            <Total label="Descuento" value={-Number(order.discount_cents)} currency={order.currency_code} />
            <Total label="Recargo" value={order.surcharge_cents} currency={order.currency_code} />
            <Total label="Envío" value={order.delivery_fee_cents} currency={order.currency_code} />
            <div className="flex justify-between pt-2 text-xl font-bold"><dt>Total</dt><dd>{formatMoney(order.total_cents, order.currency_code)}</dd></div>
          </dl>
        </section>
        <section className="form-card">
          <h2 className="form-card-title">Cliente y entrega</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <Info label="Cliente" value={order.customer_name} />
            <Info label="Teléfono" value={order.customer_phone} />
            <Info label="Modalidad" value={order.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'} />
            <Info label="Pago" value={order.payment_method_name_snapshot} />
            {deliveryAddress ? <Info label="Dirección" value={deliveryAddress} /> : null}
            {order.delivery_floor ? <Info label="Piso" value={order.delivery_floor} /> : null}
            {order.delivery_apartment ? <Info label="Departamento" value={order.delivery_apartment} /> : null}
            {order.delivery_reference ? <Info label="Referencia" value={order.delivery_reference} /> : null}
            {order.customer_notes ? <Info label="Observaciones" value={order.customer_notes} /> : null}
            {order.payment_transfer_alias_snapshot ? <Info label="Alias de transferencia" value={order.payment_transfer_alias_snapshot} /> : null}
            {order.payment_account_holder_snapshot ? <Info label="Titular" value={order.payment_account_holder_snapshot} /> : null}
            {order.payment_bank_name_snapshot ? <Info label="Banco" value={order.payment_bank_name_snapshot} /> : null}
            {order.payment_instructions_snapshot ? <Info label="Instrucciones de pago" value={order.payment_instructions_snapshot} /> : null}
          </dl>
        </section>
        {order.status === 'accepted' ? <section className="form-card">
          <h2 className="form-card-title">Acciones operativas</h2>
          <p className="mt-3 text-sm">Confirmá la {order.fulfillment_type === 'delivery' ? 'recepción del cliente' : 'entrega durante el retiro'} cuando haya recibido todo el pedido.{order.inventory_tracked?' Se descontará la existencia física reservada.':''} No confirma el cobro.</p>
          <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" checked={received} disabled={busy} onChange={(event)=>setReceived(event.target.checked)}/>Confirmo que el cliente {order.fulfillment_type==='delivery'?'recibió':'retiró'} todo el pedido.</label>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button className="button-primary" disabled={busy||!received} onClick={() => void mutate('complete_order')}><CheckCircle2 className="h-4 w-4" />{order.fulfillment_type==='delivery'?'Confirmar recepción':'Confirmar retiro'}</button>
            <input aria-label="Motivo de cancelación" disabled={busy} className="h-11 flex-1 rounded-xl border border-stone-300 px-3" placeholder="Motivo de cancelación" maxLength={300} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
            <button className="button-danger" disabled={busy} onClick={() => void mutate('cancel_order')}><XCircle className="h-4 w-4" />Cancelar{order.inventory_tracked?' y liberar reserva':''}</button>
          </div>
        </section> : null}
        {isAdmin && order.status === 'completed' && order.inventory_outcome === 'delivered' ? <section className="form-card">
          <h2 className="form-card-title">Devolución o corrección completa</h2>
          <p className="mt-3 text-sm">Se conserva el historial del pedido. Esta operación no registra cobros ni reintegros.</p>
          {pendingReverse?<p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm">Hay un intento pendiente de confirmación. Reintentá estos mismos datos para recuperar su resultado.</p>:null}
          <label className="field mt-4"><span>Qué ocurrió</span><select disabled={busy||!!pendingReverse} value={reverseKind} onChange={(event)=>{setReverseKind(event.target.value as typeof reverseKind);setRestock('');setReverseConfirmed(false)}}><option value="return">Se recibió la devolución de todo el pedido</option><option value="correction">La entrega se marcó por error y no ocurrió</option></select></label>
          <label className="field mt-4"><span>Motivo</span><textarea disabled={busy||!!pendingReverse} value={reverseReason} maxLength={500} onChange={(event)=>setReverseReason(event.target.value)}/></label>
          <label className="field mt-4"><span>Mercadería que queda vendible</span><select disabled={busy||!!pendingReverse} value={restock} onChange={(event)=>setRestock(event.target.value as typeof restock)}><option value="">Seleccioná el destino</option><option value="yes">Todo vuelve a estar disponible para vender</option>{reverseKind==='return'?<><option value="no">Nada vuelve al stock vendible</option><option value="partial">Sólo una parte vuelve al stock vendible</option></>:null}</select></label>
          {restock==='partial'?<div className="mt-4 space-y-3"><p className="text-sm">Se recibió el pedido completo. Indicá solamente las unidades vendibles que se reponen.</p>{[...deliveredProducts].map(([productId,product])=><label key={productId} className="field"><span>{product.name} · recibidas {product.quantity}</span><input type="number" min={0} max={product.quantity} step={1} disabled={busy||!!pendingReverse} value={quantities[productId]??''} onChange={(event)=>setQuantities((value)=>({...value,[productId]:event.target.value}))}/></label>)}</div>:null}
          <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" disabled={busy} checked={reverseConfirmed} onChange={(event)=>setReverseConfirmed(event.target.checked)}/>{reverseKind==='return'?'Confirmo que se recibió la devolución completa y revisé la cantidad vendible.':'Confirmo que no hubo entrega real y toda la mercadería sigue disponible.'}</label>
          <button className="button-danger mt-4" disabled={busy||!reverseConfirmed} onClick={()=>void reverse()}>{pendingReverse?'Reintentar misma operación':reverseKind==='return'?'Registrar devolución completa':'Corregir entrega marcada por error'}</button>
        </section>:null}
        {isAdmin && isReversed(order) && !inventory.replacementOrderId ? <section className="form-card">
          <h2 className="form-card-title">Vincular un pedido de reemplazo</h2>
          <p className="mt-3 text-sm">Seleccioná un pedido nuevo todavía pendiente. Quedará en la misma operación comercial; una compra nueva e independiente debe conservarse separada.</p>
          <label className="field mt-4"><span>Buscar por número de pedido</span><input value={replacementSearch} disabled={busy} onChange={(event)=>setReplacementSearch(event.target.value)} placeholder="PED-…"/></label>
          <label className="field mt-4"><span>Pedido pendiente</span><select value={replacementId} disabled={busy||replacements.isLoading} onChange={(event)=>setReplacementId(event.target.value)}><option value="">Seleccioná un pedido</option>{replacements.data?.map((candidate)=><option key={candidate.id} value={candidate.id}>{candidate.display_number} · {candidate.customer_name}</option>)}</select></label>
          {replacements.error?<p role="alert" className="form-error mt-3">{replacements.error.message}</p>:<p className="mt-2 text-xs text-stone-500">Hasta 25 pedidos recientes; buscá el número para encontrar otro.</p>}
          <label className="field mt-4"><span>Motivo del reemplazo</span><textarea maxLength={500} value={replacementReason} disabled={busy} onChange={(event)=>setReplacementReason(event.target.value)}/></label>
          <button className="button-secondary mt-4" disabled={busy||!replacementId} onClick={()=>void linkReplacement()}>Vincular como reemplazo</button>
        </section>:null}
      </div>
      <aside className="form-card h-fit">
        <h2 className="form-card-title">Línea de tiempo</h2>
        <ol className="mt-5 space-y-5 border-l-2 border-stone-200 pl-5">
          {events.map((event) => <li className="relative" key={event.id}>
            <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full bg-orange-600 ring-4 ring-white" />
            <strong className="block text-sm">{event.event_type.replace(/_/g, ' ')}</strong>
            <time className="text-xs text-stone-500">{new Date(event.created_at).toLocaleString('es-AR')}</time>
            {event.actor_user_id ? <p className="mt-1 text-xs text-stone-500">Usuario …{event.actor_user_id.slice(-8)}</p> : null}
          </li>)}
        </ol>
        {inventory.inventoryOperations.length?<><h3 className="mt-6 font-semibold">Movimientos de inventario</h3><ol className="mt-4 space-y-4">{inventory.inventoryOperations.map((operation)=><li key={operation.id} className="text-sm"><strong>{{reserve:'Reserva al aceptar',delivery:'Entrega confirmada',release:'Reserva liberada',correction:'Entrega corregida',return:'Devolución completa'}[operation.kind]??operation.kind}</strong><p className="text-xs text-stone-500">{new Date(operation.createdAt).toLocaleString('es-AR')}{operation.actorUserId?` · Usuario …${operation.actorUserId.slice(-8)}`:''}</p>{operation.reason?<p>{operation.reason}</p>:null}{operation.result.restockQuantities?.map((part)=><p key={part.productId}>{deliveredProducts.get(part.productId)?.name??'Producto'}: {part.quantity} unidades repuestas como vendibles.</p>)}{operation.result.restocked!==undefined?<p>{operation.result.restocked?'Con reposición de unidades vendibles.':'Sin reposición al stock vendible.'}</p>:null}</li>)}</ol></>:null}
      </aside>
    </div>
  </>
}

function Total({ label, value, currency }: { label: string; value: number | string; currency: string }) {
  if (Number(value) === 0) return null
  return <div className="flex justify-between"><dt>{label}</dt><dd>{formatMoney(value, currency)}</dd></div>
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs font-bold uppercase tracking-wide text-stone-400">{label}</dt><dd className="mt-1 leading-6">{value}</dd></div>
}
