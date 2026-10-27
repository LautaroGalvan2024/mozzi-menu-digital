import { Check, ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { commercePath } from '../../lib/commerce-channel'

export function StorePurchaseSteps({ slug, current }: { slug: string; current: 1 | 2 }) {
  const steps = ['Carrito', 'Tus datos', 'Confirmación']
  return <nav aria-label="Pasos de compra" className="mt-6 border-b border-stone-200 pb-5">
    <ol className="flex flex-wrap items-center gap-2 text-xs font-semibold sm:gap-4 sm:text-sm">
      {steps.map((label, index) => {
        const step = index + 1
        const content = <><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${step <= current ? 'bg-stone-900 text-white' : 'bg-stone-200 text-stone-600'}`}>{step < current ? <Check className="h-4 w-4" aria-hidden /> : step}</span><span>{label}</span></>
        return <li key={label} className="flex items-center gap-2 sm:gap-4">
          {index > 0 ? <ChevronRight className="h-3 w-3 text-stone-400" aria-hidden /> : null}
          {step < current ? <Link className="inline-flex min-h-11 items-center gap-2 rounded-lg text-stone-700 hover:underline" to={commercePath(slug, 'store', '/carrito')}>{content}</Link> : <span aria-current={step === current ? 'step' : undefined} className={`inline-flex min-h-11 items-center gap-2 ${step === current ? 'text-stone-950' : 'text-stone-500'}`}>{content}</span>}
        </li>
      })}
    </ol>
  </nav>
}
