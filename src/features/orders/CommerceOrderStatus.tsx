import { StatusPill } from './OrderStatus'
import type { AdminOrderRow } from './orderSchemas'

export function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = { unpaid: 'Sin cobro online', pending: 'Pago pendiente', approved: 'Pagado', in_process: 'Pago en revisión', in_mediation: 'Pago en disputa', authorized: 'Pago autorizado', rejected: 'Pago rechazado', cancelled: 'Pago cancelado', refunded: 'Reintegrado', partially_refunded: 'Reintegro parcial', charged_back: 'Contracargo', requires_refund: 'Requiere devolución', expired: 'Pago vencido' }
  return labels[status] ?? 'Estado de pago por verificar'
}

export function CommerceOrderStatus({ channel = 'menu', checkoutMode = 'whatsapp', paymentStatus = 'unpaid', pendingPreparation = false }: { channel?: 'menu' | 'store'; checkoutMode?: 'whatsapp' | 'online'; paymentStatus?: string; pendingPreparation?: boolean }) {
  return <div className="mt-2 flex flex-wrap gap-1.5 text-xs"><span className="rounded-full bg-stone-100 px-2 py-1 font-medium text-stone-700">{channel === 'store' ? 'Tienda' : 'Menú'} · {checkoutMode === 'online' ? 'Online' : 'WhatsApp'}</span>{checkoutMode === 'online' ? <span className={`rounded-full px-2 py-1 font-semibold ${paymentStatus === 'approved' ? 'bg-emerald-100 text-emerald-900' : ['requires_refund', 'charged_back', 'partially_refunded', 'in_mediation'].includes(paymentStatus) ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-900'}`}>{paymentStatusLabel(paymentStatus)}{paymentStatus === 'approved' && pendingPreparation ? ' · Pendiente de preparación' : ''}</span> : null}</div>
}

export function isPaidAwaitingPreparation(order: Pick<AdminOrderRow, 'checkout_mode' | 'payment_status' | 'status' | 'inventory_outcome'>) {
  return order.checkout_mode === 'online' && order.payment_status === 'approved' && order.status === 'generated' && order.inventory_outcome === 'none'
}

export function AdminOrderStatus({ order }: { order: AdminOrderRow }) {
  return <div>
    {!isPaidAwaitingPreparation(order) ? <StatusPill status={order.status} outcome={order.inventory_outcome} /> : null}
    <CommerceOrderStatus channel={order.channel} checkoutMode={order.checkout_mode} paymentStatus={order.payment_status} pendingPreparation={isPaidAwaitingPreparation(order)} />
  </div>
}
