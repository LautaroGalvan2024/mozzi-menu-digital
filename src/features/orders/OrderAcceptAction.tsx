import { PackageCheck } from 'lucide-react'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { acceptanceDescription, acceptanceLabel, canAcceptOrder, useOrderAcceptance, type AcceptableOrder } from './orderAcceptance'

export function OrderAcceptAction({ order, showDescription = false, fullWidth = false, disabled = false }: {
  order: AcceptableOrder
  showDescription?: boolean
  fullWidth?: boolean
  disabled?: boolean
}) {
  const scope = useRestaurantScope()
  const { accept, busy, message, error } = useOrderAcceptance(order, scope.selected?.id)
  return <div className={fullWidth ? 'w-full' : 'min-w-0'}>
    {canAcceptOrder(order) ? <>
      {showDescription ? <p className="mb-3 max-w-xl text-sm text-stone-600">{acceptanceDescription(order)}</p> : null}
      <button type="button" className={`button-primary min-h-11 ${fullWidth ? 'w-full' : ''}`} disabled={disabled || busy || scope.selected?.id !== order.restaurantId} onClick={() => void accept()}>
        <PackageCheck className="h-4 w-4 shrink-0" aria-hidden />{busy ? 'Aceptando…' : acceptanceLabel(order)}
      </button>
    </> : null}
    {message ? <p className="mt-3 text-sm text-stone-700" role="status">{message}</p> : null}
    {error ? <p className="form-error mt-3" role="alert">{error}</p> : null}
  </div>
}
