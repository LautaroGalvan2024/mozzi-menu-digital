import { CommerceOrderStatus } from './CommerceOrderStatus'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel } from '../../components/Feedback'
import { AdminLoading } from '../../components/AdminFeedback'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { inventoryOutcomeSchema, inventoryOutcomeLabel } from './inventoryOrder'
import { statusLabel } from './orderSchemas'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { OrderAcceptAction } from './OrderAcceptAction'
import { canAcceptOrder, useOrderUpdates } from './orderAcceptance'
import './order-workspace.css'

const status=z.enum(['generated','whatsapp_opened','accepted','completed','cancelled','expired'])
const claimOrderSchema=z.object({channel:z.enum(['menu','store']).default('menu'),checkoutMode:z.enum(['whatsapp','online']).default('whatsapp'),paymentStatus:z.string().default('unpaid'),inventoryTracked:z.boolean().default(false),inventoryOutcome:inventoryOutcomeSchema.default('none'),replacesOrderId:z.string().uuid().nullable().default(null),rootOrderId:z.string().uuid().nullable().default(null),id:z.string().uuid(),restaurantId:z.string().uuid(),actionId:z.string().uuid(),displayNumber:z.string(),status,customerName:z.string(),customerPhone:z.string(),fulfillmentType:z.enum(['delivery','pickup']),deliveryAddress:z.string().nullable(),deliveryCity:z.string().nullable(),deliveryNeighborhood:z.string().nullable(),deliveryFloor:z.string().nullable(),deliveryApartment:z.string().nullable(),deliveryReference:z.string().nullable(),customerNotes:z.string().nullable(),paymentMethodName:z.string(),paymentInstructions:z.string().nullable(),transferAlias:z.string().nullable(),subtotalCents:z.union([z.number(),z.string()]),discountCents:z.union([z.number(),z.string()]),surchargeCents:z.union([z.number(),z.string()]),deliveryFeeCents:z.union([z.number(),z.string()]),totalCents:z.union([z.number(),z.string()]),currencyCode:z.string(),whatsappOpenedAt:z.string().nullable(),acceptedBy:z.string().uuid().nullable(),acceptedByName:z.string().nullable(),acceptedAt:z.string().nullable(),completedBy:z.string().uuid().nullable(),completedByName:z.string().nullable(),completedAt:z.string().nullable(),cancelledBy:z.string().uuid().nullable(),cancelledByName:z.string().nullable(),cancelledAt:z.string().nullable(),cancelReason:z.string().nullable(),expiresAt:z.string().nullable(),createdAt:z.string(),updatedAt:z.string(),items:z.array(z.object({id:z.string().uuid(),productId:z.string().uuid().nullable(),code:z.string(),name:z.string(),quantity:z.number().int(),unitPriceCents:z.union([z.number(),z.string()]),optionsTotalUnitCents:z.union([z.number(),z.string()]),lineTotalCents:z.union([z.number(),z.string()]),notes:z.string().nullable(),options:z.array(z.object({id:z.string().uuid(),groupName:z.string(),name:z.string(),priceDeltaCents:z.union([z.number(),z.string()])}))})),events:z.array(z.object({id:z.string().uuid(),eventType:z.string(),fromStatus:status.nullable(),toStatus:status.nullable(),actorType:z.string(),actorUserId:z.string().uuid().nullable(),actorName:z.string().nullable(),metadata:z.record(z.string(),z.unknown()),createdAt:z.string()}))})

export function ClaimOrderPage() {
  const { actionId } = useParams()
  const { choices, selected, selectRestaurant } = useRestaurantScope()
  const query = useQuery({
    queryKey: ['claim-order', actionId],
    enabled: z.string().uuid().safeParse(actionId).success,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_order_by_action', { p_action_id: actionId ?? '' })
      if (error) throw new Error('No existe el pedido o no tenés acceso a este restaurante.')
      return claimOrderSchema.parse(data)
    },
  })
  const targetRestaurantId = query.data?.restaurantId
  useOrderUpdates(targetRestaurantId, query.data?.id, actionId)
  useEffect(() => {
    if (!targetRestaurantId || selected?.id === targetRestaurantId) return
    if (choices.some(restaurant => restaurant.id === targetRestaurantId)) selectRestaurant(targetRestaurantId)
  }, [choices, selected?.id, selectRestaurant, targetRestaurantId])
  if (query.isLoading) return <main className="admin-app order-claim"><AdminLoading label="Verificando acceso al pedido…" /></main>
  if (query.error || !query.data) return <main className="admin-app order-claim"><div className="order-claim-inner"><ErrorPanel title="No pudimos abrir el pedido" headingLevel={1}>{query.error?.message ?? 'Enlace inválido.'}</ErrorPanel></div></main>
  const order = query.data
  return <main className="admin-app order-claim">
    <div className="order-claim-inner">
      <PageHeader title={order.displayNumber} description={canAcceptOrder(order) ? 'Revisá el pedido antes de aceptarlo.' : 'Consultá el estado y el detalle del pedido.'} />
      <div className="order-claim-grid">
        <section className="form-card order-claim-contact" aria-labelledby="claim-customer">
          <div>
            <h2 id="claim-customer" className="form-card-title">Cliente y entrega</h2>
            <p className="font-semibold">{order.customerName}</p>
            <a className="inline-flex min-h-11 items-center text-sm font-semibold underline" href={`tel:${order.customerPhone}`}>{order.customerPhone}</a>
            <p className="text-sm text-stone-600">{order.fulfillmentType === 'delivery' ? 'Envío' : 'Retiro'} · {order.paymentMethodName}</p>
          </div>
          {order.deliveryAddress ? <div className="order-claim-info">
            <p><strong>Dirección</strong> {[order.deliveryAddress, order.deliveryNeighborhood, order.deliveryCity].filter(Boolean).join(', ')}</p>
            {order.deliveryFloor || order.deliveryApartment ? <p><strong>Unidad</strong> {[order.deliveryFloor ? `Piso ${order.deliveryFloor}` : null, order.deliveryApartment ? `Depto ${order.deliveryApartment}` : null].filter(Boolean).join(' · ')}</p> : null}
            {order.deliveryReference ? <p><strong>Referencia</strong> {order.deliveryReference}</p> : null}
          </div> : null}
          {order.customerNotes ? <p className="order-claim-info"><strong>Observaciones</strong> {order.customerNotes}</p> : null}
          {order.transferAlias || order.paymentInstructions ? <div className="order-claim-info">
            <p><strong>Pago</strong> {order.paymentMethodName}</p>
            {order.transferAlias ? <p><strong>Alias</strong> {order.transferAlias}</p> : null}
            {order.paymentInstructions ? <p><strong>Instrucciones</strong> {order.paymentInstructions}</p> : null}
          </div> : null}
        </section>
        <section className="form-card" aria-labelledby="claim-items">
          <div className="order-claim-summary-heading">
            <h2 id="claim-items" className="form-card-title">Productos del pedido</h2>
            <p className="font-display text-xl font-bold tabular-nums">{formatMoney(order.totalCents, order.currencyCode)}</p>
          </div>
          <CommerceOrderStatus channel={order.channel} checkoutMode={order.checkoutMode} paymentStatus={order.paymentStatus} pendingPreparation={order.status === 'generated'} />
          <div className="mt-3 divide-y divide-stone-100">{order.items.map(item => (
            <div className="order-detail-line py-3" key={item.id}>
              <div>
                <strong>{item.quantity} × {item.name}</strong>
                {item.options.map(option => <p className="text-xs text-stone-600" key={option.id}>{option.groupName} · {option.name}</p>)}
                {item.notes ? <p className="mt-1 text-xs italic text-stone-600">“{item.notes}”</p> : null}
              </div>
              <strong>{formatMoney(item.lineTotalCents, order.currencyCode)}</strong>
            </div>
          ))}</div>
        </section>
      </div>
      <section className="form-card order-claim-action" aria-label="Estado y acciones">
        {!canAcceptOrder(order) ? <div>
          <div className="flex items-center gap-2">
            {['accepted', 'completed'].includes(order.status) ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-700" aria-hidden /> : null}
            <h2 className="text-base font-bold">{order.inventoryOutcome === 'corrected' || order.inventoryOutcome === 'returned' ? inventoryOutcomeLabel[order.inventoryOutcome] : statusLabel[order.status]}</h2>
          </div>
          {order.acceptedAt ? <p className="mt-1 text-sm text-stone-600">{order.acceptedByName ?? 'Un operador'} · {new Date(order.acceptedAt).toLocaleString('es-AR')}</p> : null}
        </div> : null}
        <OrderAcceptAction key={order.id} order={order} showDescription fullWidth />
        <Link className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline" to={`/admin/pedidos/${order.id}`} onClick={() => selectRestaurant(order.restaurantId)}>Abrir detalle completo</Link>
      </section>
    </div>
  </main>
}
