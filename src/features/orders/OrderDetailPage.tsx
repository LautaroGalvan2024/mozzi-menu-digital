import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { adminOrderSchema, eventSchema, itemOptionSchema, itemSchema } from './orderSchemas'
import { StatusPill } from './OrderStatus'

export function OrderDetailPage() {
  const { orderId } = useParams()
  const scope = useRestaurantScope()
  const client = useQueryClient()
  const [cancelReason, setCancelReason] = useState('')
  const [error, setError] = useState<string | null>(null)
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
      return { order, items, options, events: z.array(eventSchema).parse(eventsResult.data) }
    },
  })

  if (query.isLoading) return <LoadingScreen />
  if (query.error || !query.data) {
    return <ErrorPanel>{query.error?.message ?? 'Pedido inexistente o sin acceso.'}</ErrorPanel>
  }

  const { order, items, options, events } = query.data

  async function mutate(name: 'complete_order' | 'cancel_order') {
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
    const { error: rpcError } = await supabase.rpc(name, args)
    if (rpcError) {
      setError('No se pudo cambiar el estado. Puede que otro operador ya lo haya modificado.')
    } else {
      await client.invalidateQueries({ queryKey: ['order-detail', scope.selected.id, order.id] })
    }
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
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-6">
        <section className="form-card">
          <div className="flex justify-between"><h2 className="form-card-title">Productos</h2><StatusPill status={order.status} /></div>
          <div className="mt-5 divide-y divide-stone-200">
            {items.map((item) => <article className="py-4 first:pt-0" key={item.id}>
              <div className="flex justify-between gap-3">
                <div><strong>{item.quantity} × {item.product_name_snapshot}</strong><p className="text-xs text-stone-500">{item.product_code_snapshot}</p></div>
                <strong>{formatMoney(item.line_total_cents, order.currency_code)}</strong>
              </div>
              {options.filter((option) => option.order_item_id === item.id).map((option) => <p key={option.id} className="mt-1 pl-4 text-sm text-stone-600">· {option.group_name_snapshot}: {option.option_name_snapshot}{Number(option.price_delta_cents) ? ` (+${formatMoney(option.price_delta_cents, order.currency_code)})` : ''}</p>)}
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
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button className="button-primary" onClick={() => void mutate('complete_order')}><CheckCircle2 className="h-4 w-4" />Completar</button>
            <input className="h-11 flex-1 rounded-xl border border-stone-300 px-3" placeholder="Motivo de cancelación" maxLength={300} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
            <button className="button-danger" onClick={() => void mutate('cancel_order')}><XCircle className="h-4 w-4" />Cancelar</button>
          </div>
          {error ? <p className="form-error mt-3">{error}</p> : null}
        </section> : null}
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
