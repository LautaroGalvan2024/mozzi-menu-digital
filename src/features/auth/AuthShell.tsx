import { UtensilsCrossed } from 'lucide-react'
import type { PropsWithChildren, ReactNode } from 'react'
import { Link } from 'react-router'

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: PropsWithChildren<{
  title: string
  subtitle: string
  footer?: ReactNode
}>) {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#ffe7dc,transparent_40%),#f7f4ef] px-4 py-10">
      <div className="mx-auto w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 text-stone-950">
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-orange-600 text-white shadow-lg shadow-orange-900/15">
            <UtensilsCrossed className="h-5 w-5" aria-hidden />
          </span>
          <span className="font-display text-2xl font-bold tracking-tight">Mozzi</span>
        </Link>
        <section className="rounded-[2rem] border border-white/80 bg-white/90 p-6 shadow-xl shadow-stone-900/5 backdrop-blur sm:p-8">
          <h1 className="font-display text-3xl font-bold tracking-tight text-stone-950">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-stone-600">{subtitle}</p>
          <div className="mt-7">{children}</div>
          {footer ? <div className="mt-6 border-t border-stone-200 pt-5">{footer}</div> : null}
        </section>
      </div>
    </main>
  )
}
