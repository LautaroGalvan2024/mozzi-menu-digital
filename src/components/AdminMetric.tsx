import type { LucideIcon } from 'lucide-react'

export function AdminMetric({ label, value, detail, icon: Icon, amount = false }: {
  label: string
  value: string | number
  detail?: string
  icon?: LucideIcon
  amount?: boolean
}) {
  return <article className={`admin-metric${amount ? ' admin-metric--amount' : ''}`}>
    <div className="admin-metric-heading">
      <h2>{label}</h2>
      {Icon ? <span className="admin-metric-symbol"><Icon aria-hidden /></span> : null}
    </div>
    <p className="admin-metric-value">{value}</p>
    {detail ? <p className="admin-metric-detail">{detail}</p> : null}
  </article>
}
