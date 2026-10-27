import { CheckCircle2, Clock3, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { commercePath } from '../../lib/commerce-channel'
import { ErrorPanel } from '../../components/Feedback'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { paymentSessionSchema, paymentStatusSchema, readPaymentRecovery, savePaymentRecovery, type PaymentStatus } from './payment-recovery'

export function PaymentStatusPage() {
  const { restaurantSlug = '' } = useParams()
  return <PaymentConfirmation key={restaurantSlug} slug={restaurantSlug} />
}

function PaymentConfirmation({ slug }: { slug: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [initial] = useState(() => paymentSessionSchema.safeParse(location.state))
  const [result, setResult] = useState<PaymentStatus | null>(initial.success ? initial.data : null)
  const [reference] = useState(() => {
    if (initial.success) {
      savePaymentRecovery(slug, initial.data)
      return { actionId: initial.data.order.actionId, token: initial.data.recoveryToken, expiresAt: initial.data.recoveryExpiresAt }
    }
    return readPaymentRecovery(slug)
  })
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (!reference) return
    setBusy(true); setError(null); setNow(Date.now())
    try {
      const response = await supabase.functions.invoke('payment-status', { body: { actionId: reference.actionId, recoveryToken: reference.token } })
      if (response.error) throw new Error('No pudimos consultar el pago. Reintentá antes de comenzar otra compra.')
      const parsed = paymentStatusSchema.safeParse(response.data)
      if (!parsed.success || parsed.data.order.actionId !== reference.actionId) throw new Error('No pudimos verificar la respuesta del pago.')
      setResult(parsed.data)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No pudimos consultar el pago.') }
    finally { setBusy(false) }
  }, [reference])
  useEffect(() => {
    // URL query parameters are never evidence that a payment succeeded.
    if (location.search || location.state) void navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.search, location.state, navigate])
  useEffect(() => { void refresh() }, [refresh])
  const terminal = result && ['approved', 'paid', 'refunded', 'partially_refunded', 'charged_back', 'cancelled', 'expired', 'requires_refund', 'refund_required'].includes(result.payment.status)
  useEffect(() => {
    if (!reference || terminal) return
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [reference, refresh, terminal])
  const paid = result && ['approved', 'paid'].includes(result.payment.status)
  const refund = result && (result.payment.requiresRefund || ['requires_refund', 'refund_required'].includes(result.payment.status))
  const paymentExpired = result && ['unpaid', 'created', 'pending', 'rejected'].includes(result.payment.status) && (result.order.status === 'expired' || Boolean(result.payment.expiresAt && Date.parse(result.payment.expiresAt) <= now))
  const labels: Record<string, string> = { unpaid: 'Pago por iniciar', created: 'Pago por iniciar', pending: 'Pago pendiente', in_process: 'Pago en revisión', authorized: 'Pago en revisión', approved: 'Pago aprobado', paid: 'Pago aprobado', rejected: 'Pago rechazado', cancelled: 'Pago cancelado', expired: 'El plazo de pago venció', refunded: 'Pago devuelto', partially_refunded: 'Pago devuelto parcialmente', charged_back: 'Pago en disputa', requires_refund: 'Devolución pendiente', refund_required: 'Devolución pendiente' }
  const canPay = result?.payment.checkoutUrl && ['created', 'pending', 'rejected'].includes(result.payment.status) && (!result.payment.expiresAt || Date.parse(result.payment.expiresAt) > now) && !refund && !result.payment.reviewRequired
  return <main className="grid min-h-screen place-items-center bg-stone-100 p-4"><section className="w-full max-w-xl rounded-3xl bg-white p-7 text-center shadow-lg">
    {paid && !refund && !result.payment.reviewRequired ? <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" /> : <Clock3 className="mx-auto h-14 w-14 text-stone-500" />}
    <h1 className="mt-5 font-display text-3xl font-bold">{refund ? 'Tu compra necesita atención' : paymentExpired ? 'El plazo de pago venció' : result ? labels[result.payment.status] ?? 'Consultando el estado del pago' : 'Consultar compra'}</h1>
    {result ? <><p className="mt-3 text-sm text-stone-500">Pedido {result.order.displayNumber}</p><p className="mt-2 text-2xl font-bold">{formatMoney(result.order.totalCents, result.order.currencyCode)}</p><p className="mt-4 text-sm leading-6 text-stone-600">{refund || result.payment.reviewRequired ? 'El comercio necesita revisar este pago y resolver la compra o su devolución. No vuelvas a pagar.' : paid ? result.order.status === 'completed' ? 'Tu compra fue entregada.' : result.order.status === 'cancelled' ? 'El pedido fue cancelado. La devolución del pago se gestiona por separado; consultá al comercio.' : 'El pago fue confirmado. El comercio preparará tu pedido.' : result.payment.status === 'refunded' ? 'Mercado Pago confirmó la devolución.' : 'El estado se verifica con Mercado Pago. Si ya pagaste, esperá la confirmación antes de intentar otra compra.'}</p></> : null}
    {!reference ? <div className="mt-5"><ErrorPanel title="Acceso no disponible">La consulta temporal venció o pertenece a otro dispositivo. Consultá al comercio antes de repetir la compra.</ErrorPanel></div> : null}
    {error ? <p className="form-error mt-4" role="alert">{error}</p> : null}
    {canPay ? <a className="button-primary mt-6 min-h-12 w-full" href={result.payment.checkoutUrl!}><ExternalLink className="h-5 w-5" />Pagar en Mercado Pago</a> : null}
    {reference ? <button className="button-secondary mt-3 w-full" disabled={busy} onClick={() => void refresh()}>{busy ? 'Consultando…' : 'Actualizar estado'}</button> : null}
    <Link className="mt-5 inline-block text-sm underline" to={commercePath(slug, 'store')}>Volver a la tienda</Link>
  </section></main>
}
