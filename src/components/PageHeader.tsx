import type { ReactNode } from 'react'

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div>{eyebrow ? <p className="mb-1 text-xs font-bold uppercase tracking-[.18em] text-orange-700">{eyebrow}</p> : null}<h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>{description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{description}</p> : null}</div>{actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}</header>
}
