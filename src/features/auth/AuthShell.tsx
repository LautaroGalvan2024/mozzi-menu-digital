import { MozziBrand } from '../../components/MozziBrand'
import type { PropsWithChildren, ReactNode } from 'react'
import { Link } from 'react-router'
import '../../admin.css'

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
      <div className="admin-auth-layout">
        <section className="admin-auth-card">
          <Link to="/" className="admin-auth-brand"><MozziBrand /></Link>
          <h1 className="font-display text-3xl font-bold tracking-tight text-stone-950">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm leading-6 text-stone-600">{subtitle}</p> : null}
          <div className="mt-7">{children}</div>
          {footer ? <div className="admin-auth-footer">{footer}</div> : null}
        </section>
      </div>
    </main>
  )
}
