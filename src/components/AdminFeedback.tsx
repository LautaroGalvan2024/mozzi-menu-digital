import { AlertCircle, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

export function AdminLoading({ label = 'Cargando…', variant = 'page' }: { label?: string; variant?: 'page' | 'list' }) {
  return (
    <div className={`feedback-loading feedback-loading--${variant}`} role="status">
      <div className="feedback-loading-label">
        <LoaderCircle className="h-4 w-4 animate-spin text-orange-600" aria-hidden />
        <span>{label}</span>
      </div>
      <div className="feedback-skeleton" aria-hidden="true"><i /><i /><i /></div>
    </div>
  )
}

const feedbackIcons = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: AlertCircle,
}

export function InlineFeedback({ tone, children, className = '', role = tone === 'error' ? 'alert' : 'status' }: {
  tone: keyof typeof feedbackIcons
  children: ReactNode
  className?: string
  role?: 'alert' | 'status'
}) {
  const Icon = feedbackIcons[tone]
  return <div className={`inline-feedback inline-feedback--${tone} ${className}`} role={role}>
    <Icon size={18} aria-hidden />
    <div>{children}</div>
  </div>
}
