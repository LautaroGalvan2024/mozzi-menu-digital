import type { ReactNode } from 'react'

export function FilterBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`filter-bar ${className}`} aria-label="Filtros">{children}</section>
}
