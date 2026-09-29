import { statusLabel, type AdminOrderRow } from './orderSchemas'

export function StatusPill({status}:{status:AdminOrderRow['status']}) {
  const colors: Record<AdminOrderRow['status'], { badge: string; dot: string }> = {
    generated: { badge: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
    whatsapp_opened: { badge: 'border-violet-200 bg-violet-50 text-violet-800', dot: 'bg-violet-500' },
    accepted: { badge: 'border-blue-200 bg-blue-50 text-blue-800', dot: 'bg-blue-500' },
    completed: { badge: 'border-emerald-200 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500' },
    cancelled: { badge: 'border-red-200 bg-red-50 text-red-800', dot: 'bg-red-500' },
    expired: { badge: 'border-stone-300 bg-stone-100 text-stone-700', dot: 'bg-stone-500' },
  }
  return (
    <span className={`status-badge whitespace-nowrap ${colors[status].badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${colors[status].dot}`} aria-hidden />
      {statusLabel[status]}
    </span>
  )
}
