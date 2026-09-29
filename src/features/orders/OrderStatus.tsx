import { Radio } from 'lucide-react'
import { statusLabel, type AdminOrderRow } from './orderSchemas'

export function StatusPill({status}:{status:AdminOrderRow['status']}) {
  const colors:Record<AdminOrderRow['status'],string>={generated:'bg-amber-100 text-amber-800',whatsapp_opened:'bg-purple-100 text-purple-800',accepted:'bg-blue-100 text-blue-800',completed:'bg-emerald-100 text-emerald-800',cancelled:'bg-red-100 text-red-800',expired:'bg-stone-200 text-stone-700'}
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${colors[status]}`}><Radio className="h-3 w-3" aria-hidden/>{statusLabel[status]}</span>
}
