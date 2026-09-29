import type { ReactNode } from 'react'

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-7 flex flex-col justify-between gap-5 border-b border-current/10 pb-6 sm:flex-row sm:items-end">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[.16em] text-orange-700">{eyebrow}</p> : null}
        <h1 className="font-display text-3xl font-bold leading-tight tracking-[-.025em] sm:text-[2.25rem]">{title}</h1>
        {description ? <p className="mt-2 max-w-3xl text-sm leading-6 opacity-70 sm:text-[15px]">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  )
}
