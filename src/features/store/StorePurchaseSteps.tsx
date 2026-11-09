import { Check, ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { commercePath } from '../../lib/commerce-channel'
import './store-purchase.css'

export function StorePurchaseSteps({ slug, current }: { slug: string; current: 1 | 2 }) {
  const steps = ['Carrito', 'Tus datos', 'Confirmación']
  return <nav aria-label="Pasos de compra" className="store-purchase-steps">
    <ol>
      {steps.map((label, index) => {
        const step = index + 1
        const state = step < current ? 'complete' : step === current ? 'current' : 'upcoming'
        const content = <><span className="store-purchase-step-number">{step < current ? <Check className="h-4 w-4" aria-hidden /> : step}</span><span className="store-purchase-step-label">{label}</span></>
        return <li key={label} data-state={state}>
          {index > 0 ? <ChevronRight className="store-purchase-step-chevron" aria-hidden /> : null}
          {step < current
            ? <Link aria-label={`Volver a ${label}`} to={commercePath(slug, 'store', '/carrito')}>{content}</Link>
            : <span aria-label={label} aria-current={step === current ? 'step' : undefined}>{content}</span>}
        </li>
      })}
    </ol>
  </nav>
}
