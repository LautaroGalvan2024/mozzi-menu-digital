import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

const tones = {
  amber: 'bg-amber-50 text-amber-700 ring-amber-100',
  blue: 'bg-blue-50 text-blue-700 ring-blue-100',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  red: 'bg-red-50 text-red-700 ring-red-100',
  orange: 'bg-orange-50 text-orange-700 ring-orange-100',
} as const

export function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'orange',
  detail,
}: {
  label: string
  value: ReactNode
  icon: LucideIcon
  tone?: keyof typeof tones
  detail?: ReactNode
}) {
  return (
    <article className="surface-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">{label}</p>
          <p className="mt-2 font-display text-3xl font-bold tracking-tight text-stone-950">{value}</p>
        </div>
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${tones[tone]}`}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      </div>
      {detail ? <div className="mt-4 border-t border-stone-100 pt-3 text-xs text-stone-500">{detail}</div> : null}
    </article>
  )
}
