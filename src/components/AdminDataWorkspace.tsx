import clsx from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'

export function AdminDataWorkspace({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={clsx('admin-data-workspace', className)}>{children}</div>
}

export function AdminDataRegion({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section className={clsx('admin-data-region', className)} {...props}>
      {children}
    </section>
  )
}
