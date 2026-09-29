import { AlertCircle, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'

export function LoadingScreen({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="grid min-h-[50vh] place-items-center" role="status">
      <div className="flex items-center gap-3 text-stone-600">
        <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
        <span>{label}</span>
      </div>
    </div>
  )
}

export function ErrorPanel({
  title = 'No pudimos completar la operación',
  children,
  action,
}: {
  title?: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-950" role="alert">
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div>
          <h2 className="font-semibold">{title}</h2>
          <div className="mt-1 text-sm text-red-800">{children}</div>
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-3xl border border-dashed border-stone-300 bg-white p-10 text-center">
      <h2 className="font-display text-xl font-semibold text-stone-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-stone-600">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
