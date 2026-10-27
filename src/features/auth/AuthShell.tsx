import { MozziBrand } from '../../components/MozziBrand'
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
    <main className="admin-app admin-auth">
      <div className="mx-auto w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 text-stone-950">
          <MozziBrand />
        </Link>
        <section className="admin-auth-card">
          <h1 className="font-display text-3xl font-bold tracking-tight text-stone-950">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-stone-600">{subtitle}</p>
          <div className="mt-7">{children}</div>
          {footer ? <div className="mt-6 border-t border-stone-200 pt-5">{footer}</div> : null}
        </section>
      </div>
    </main>
  )
}
