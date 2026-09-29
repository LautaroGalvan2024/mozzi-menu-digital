import type { ReactNode } from 'react'

export function SectionCard({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`surface-card p-5 sm:p-6 ${className}`}>
      {title || description || action ? (
        <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title ? <h2 className="font-display text-lg font-bold tracking-tight text-stone-950">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm leading-5 text-stone-500">{description}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  )
}
