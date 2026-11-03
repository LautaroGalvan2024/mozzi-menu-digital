import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { invalidateCatalogQueries } from '../../lib/catalog-cache'
import { queryKeys } from '../../lib/queryKeys'
import { supabase } from '../../lib/supabase/client'
import { inventoryOrderError } from './inventoryOrder'
import { statusLabel, type AdminOrderRow } from './orderSchemas'

export interface AcceptableOrder {
  id: string
  restaurantId: string
  actionId: string
  status: AdminOrderRow['status']
  checkoutMode: 'whatsapp' | 'online'
  paymentStatus: string
  inventoryTracked: boolean
}

export function acceptanceOrder(order: AdminOrderRow): AcceptableOrder {
  return {
    id: order.id, restaurantId: order.restaurant_id, actionId: order.action_id,
    status: order.status, checkoutMode: order.checkout_mode,
    paymentStatus: order.payment_status, inventoryTracked: order.inventory_tracked,
  }
}

export function canAcceptOrder(order: AcceptableOrder): boolean {
  return ['generated', 'whatsapp_opened'].includes(order.status)
    && (order.checkoutMode !== 'online' || order.paymentStatus === 'approved')
}

export function acceptanceLabel(order: AcceptableOrder): string {
  return order.checkoutMode === 'online' ? 'Aceptar para preparar'
    : order.inventoryTracked ? 'Aceptar y reservar' : 'Aceptar pedido'
}

export function acceptanceDescription(order: AcceptableOrder): string {
  return order.checkoutMode === 'online'
    ? 'El pago está aprobado y las unidades ya están reservadas. Aceptá para preparar el pedido.'
    : order.inventoryTracked
      ? 'Al aceptar se reservan las unidades. La existencia física se descuenta cuando confirmes la recepción del cliente o el retiro.'
      : 'Confirmá la aceptación con el botón.'
}

const claimResultSchema = z.object({
  claimed: z.boolean(), alreadyClaimed: z.boolean(),
  status: z.enum(['generated', 'whatsapp_opened', 'accepted', 'completed', 'cancelled', 'expired']),
}).refine(result => !result.claimed || result.status === 'accepted')

export async function invalidateOrderQueries(client: QueryClient, restaurantId: string, actionId?: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.orders(restaurantId) }),
    client.invalidateQueries({ queryKey: ['order-detail', restaurantId] }),
    client.invalidateQueries({ queryKey: ['order-replacements', restaurantId] }),
    client.invalidateQueries({ queryKey: ['claim-order', ...(actionId ? [actionId] : [])] }),
    client.invalidateQueries({ queryKey: queryKeys.dashboardOrders(restaurantId) }),
    invalidateCatalogQueries(client, restaurantId),
  ])
}

/** Refresh both administrative entry points when another operator changes an order. */
export function useOrderUpdates(restaurantId?: string, orderId?: string, actionId?: string) {
  const client = useQueryClient()
  useEffect(() => {
    if (!restaurantId) return
    const channel = supabase.channel(`orders:${restaurantId}:${orderId ?? 'list'}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'orders',
        filter: orderId ? `id=eq.${orderId}` : `restaurant_id=eq.${restaurantId}`,
      }, payload => {
        const changedAction = 'action_id' in payload.new && typeof payload.new.action_id === 'string'
          ? payload.new.action_id : actionId
        void invalidateOrderQueries(client, restaurantId, changedAction)
      }).subscribe(status => {
        // Reconnection can follow a missed acceptance from another tab/device.
        if (status === 'SUBSCRIBED') void invalidateOrderQueries(client, restaurantId, actionId)
      })
    return () => { void supabase.removeChannel(channel) }
  }, [client, restaurantId, orderId, actionId])
}

export function useOrderAcceptance(order: AcceptableOrder, selectedRestaurantId?: string) {
  const client = useQueryClient()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    if (running.current || !canAcceptOrder(order)) return
    setError(null)
    setMessage(null)
    if (selectedRestaurantId !== order.restaurantId) {
      setError('El pedido no pertenece al comercio seleccionado.')
      return
    }
    running.current = true
    setBusy(true)
    try {
      const { data, error: rpcError } = await supabase.rpc('claim_order', { p_action_id: order.actionId })
      if (rpcError) throw rpcError
      const result = claimResultSchema.parse(data)
      if (result.claimed) {
        setMessage(order.checkoutMode === 'online'
          ? 'Pedido aceptado para preparar. Se conserva la reserva del pago.'
          : order.inventoryTracked
            ? 'Pedido aceptado. Las unidades quedaron reservadas; todavía no se descontó la existencia física.'
            : 'Pedido aceptado correctamente.')
      } else if (result.status === 'accepted' && result.alreadyClaimed) {
        setMessage('El pedido ya había sido aceptado. No se creó otra reserva.')
      } else {
        setMessage(`El pedido está ${statusLabel[result.status].toLocaleLowerCase('es-AR')}. No se creó otra reserva.`)
      }
    } catch (failure) {
      setError(inventoryOrderError(failure))
    } finally {
      try { await invalidateOrderQueries(client, order.restaurantId, order.actionId) }
      finally { running.current = false; setBusy(false) }
    }
  }

  return { accept, busy, message, error }
}
