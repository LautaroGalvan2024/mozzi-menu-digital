import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock3, ExternalLink, LoaderCircle, PackageCheck, RefreshCw, ShieldAlert, Undo2, XCircle, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { commercePath } from '../../lib/commerce-channel'
import { ErrorPanel } from '../../components/Feedback'
import { WhatsAppIcon } from '../../components/WhatsAppIcon'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { paymentSessionSchema, paymentStatusSchema, readPaymentRecovery, savePaymentRecovery, type PaymentStatus } from './payment-recovery'

type PaymentPresentation = {
  title: string
  description: string
  nextTitle: string
  nextDescription: string
  icon: LucideIcon
  tone: 'success' | 'neutral' | 'attention'
  whatsapp?: boolean
}

function paymentPresentation(result: PaymentStatus, expired: boolean): PaymentPresentation {
  const status = result.payment.status
  if (result.payment.requiresRefund || ['requires_refund', 'refund_required'].includes(status)) {
    return { title: 'Tu compra necesita atención', description: 'El pago necesita una revisión del comercio.', nextTitle: 'La devolución está pendiente de revisión', nextDescription: 'Consultá al comercio para resolver la compra o su devolución. No vuelvas a pagar.', icon: ShieldAlert, tone: 'attention' }
  }
  if (status === 'refunded') {
    return { title: 'Pago devuelto', description: 'Mercado Pago confirmó la devolución de este pago.', nextTitle: 'Consultá el detalle del reintegro', nextDescription: 'Podés ver el estado de la devolución en la actividad de Mercado Pago.', icon: Undo2, tone: 'neutral' }
  }
  if (status === 'partially_refunded') {
    return { title: 'Pago devuelto parcialmente', description: 'Se devolvió una parte del importe de tu compra.', nextTitle: 'Revisá el detalle con el comercio', nextDescription: 'Consultá al comercio por la devolución y el estado del pedido. No vuelvas a pagar.', icon: Undo2, tone: 'attention' }
  }
  if (status === 'charged_back' || status === 'in_mediation' || result.payment.reviewRequired) {
    return { title: status === 'charged_back' || status === 'in_mediation' ? 'Pago en disputa' : 'Tu compra necesita atención', description: 'Este pago necesita revisión antes de continuar con la compra.', nextTitle: 'Esperá la resolución del pago', nextDescription: 'Revisá el caso en Mercado Pago y consultá al comercio. No vuelvas a pagar.', icon: ShieldAlert, tone: 'attention' }
  }
  if (['approved', 'paid'].includes(status)) {
    if (result.order.status === 'completed') {
      return { title: 'Compra entregada', description: 'El comercio marcó tu pedido como entregado.', nextTitle: 'El pago está aprobado', nextDescription: 'Podés volver a consultar esta compra desde este mismo dispositivo.', icon: PackageCheck, tone: 'success' }
    }
    if (result.order.status === 'cancelled') {
      return { title: 'Pedido cancelado', description: 'El pago figura aprobado, pero el pedido fue cancelado.', nextTitle: 'Consultá por la devolución', nextDescription: 'Cancelar el pedido no devuelve el dinero automáticamente. La devolución se gestiona por separado; consultá al comercio y no vuelvas a pagar.', icon: XCircle, tone: 'attention' }
    }
    if (['generated', 'whatsapp_opened', 'accepted'].includes(result.order.status)) {
      return { title: 'Pago aprobado', description: 'Mercado Pago confirmó tu pago.', nextTitle: '¿Qué pasa ahora?', nextDescription: 'En breve, el comercio se comunicará por WhatsApp al número que ingresaste para darte los detalles de tu pedido.', icon: CheckCircle2, tone: 'success', whatsapp: true }
    }
    return { title: 'Tu compra necesita atención', description: 'El pago figura aprobado, pero el estado del pedido necesita revisión.', nextTitle: 'Consultá al comercio', nextDescription: 'El comercio debe verificar cómo continuar con tu compra. No vuelvas a pagar.', icon: ShieldAlert, tone: 'attention' }
  }
  if (result.order.status === 'cancelled') {
    return { title: 'Pedido cancelado', description: 'Este pedido fue cancelado.', nextTitle: 'Si llegaste a pagar', nextDescription: 'Actualizá el estado y consultá al comercio antes de intentar otra compra. La cancelación del pedido no confirma una devolución.', icon: XCircle, tone: 'neutral' }
  }
  if (expired || status === 'expired') {
    return { title: 'El plazo de pago venció', description: 'El enlace de pago de esta compra ya no está disponible.', nextTitle: 'Si llegaste a pagar', nextDescription: 'Actualizá el estado y esperá la confirmación de Mercado Pago antes de intentar otra compra.', icon: Clock3, tone: 'neutral' }
  }
  if (status === 'rejected') {
    return { title: 'Pago rechazado', description: 'Mercado Pago no aprobó este intento de pago.', nextTitle: 'Revisá el resultado antes de reintentar', nextDescription: 'Si no tenés otro pago pendiente para esta compra, podés volver a intentarlo desde el mismo enlace de Mercado Pago.', icon: XCircle, tone: 'attention' }
  }
  if (status === 'cancelled') {
    return { title: 'Pago cancelado', description: 'Este pago figura cancelado.', nextTitle: 'Si llegaste a pagar', nextDescription: 'Revisá la actividad de Mercado Pago y consultá al comercio antes de intentar otra compra.', icon: XCircle, tone: 'neutral' }
  }
  if (['unpaid', 'created'].includes(status)) {
    return { title: 'Pago por iniciar', description: 'Tu compra todavía no tiene un pago confirmado.', nextTitle: 'Completá el pago en Mercado Pago', nextDescription: 'Usá el enlace de esta misma compra. Si ya pagaste, actualizá el estado y esperá la confirmación sin volver a pagar.', icon: Clock3, tone: 'neutral' }
  }
  if (status === 'pending') {
    return { title: 'Pago pendiente de confirmación', description: 'Todavía no recibimos la aprobación de Mercado Pago.', nextTitle: 'Si ya pagaste, esperá la confirmación', nextDescription: 'El estado se actualiza automáticamente. No vuelvas a pagar ni inicies otra compra. Si todavía no pagaste, podés continuar con esta misma compra en Mercado Pago.', icon: Clock3, tone: 'neutral' }
  }
  return { title: 'Pago en revisión', description: 'Estamos esperando la confirmación de Mercado Pago.', nextTitle: 'Esperá el resultado del pago', nextDescription: 'El estado se actualiza automáticamente. No vuelvas a pagar ni inicies otra compra mientras se confirma el resultado.', icon: Clock3, tone: 'neutral' }
}

const orderLabels: Record<string, string> = {
  generated: 'Pendiente de confirmación del comercio',
  whatsapp_opened: 'Pendiente de confirmación del comercio',
  accepted: 'Aceptado por el comercio',
  completed: 'Entregado',
  cancelled: 'Cancelado',
  expired: 'Vencido',
}

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
  useEffect(() => {
    const expiry = result?.payment.expiresAt ? Date.parse(result.payment.expiresAt) : NaN
    const remaining = expiry - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647) return
    const timer = window.setTimeout(() => setNow(Date.now()), remaining)
    return () => window.clearTimeout(timer)
  }, [result?.payment.expiresAt])
  const paymentExpired = Boolean(result && ['unpaid', 'created', 'pending', 'rejected', 'in_process', 'authorized'].includes(result.payment.status) && (result.order.status === 'expired' || Boolean(result.payment.expiresAt && Date.parse(result.payment.expiresAt) <= now)))
  const presentation = result ? paymentPresentation(result, paymentExpired) : null
  const canPay = result?.payment.checkoutUrl && ['unpaid', 'created', 'pending', 'rejected'].includes(result.payment.status) && !paymentExpired && !['cancelled', 'completed', 'expired'].includes(result.order.status) && (!result.payment.expiresAt || Date.parse(result.payment.expiresAt) > now) && !result.payment.requiresRefund && !result.payment.reviewRequired && !error && !busy
  const Icon = presentation?.icon ?? (error || !reference ? ShieldAlert : LoaderCircle)
  const tone = presentation?.tone ?? 'neutral'
  return <main className="min-h-screen bg-stone-50 px-4 py-8 sm:grid sm:place-items-center sm:py-12">
    <section aria-labelledby="payment-result-title" className="mx-auto w-full max-w-xl overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm">
      <div className={`h-1.5 ${tone === 'success' ? 'bg-emerald-500' : tone === 'attention' ? 'bg-amber-400' : 'bg-stone-300'}`} />
      <div className="p-6 sm:p-8">
        <header className="text-center" aria-live="polite">
          <div className={`mx-auto grid h-20 w-20 place-items-center rounded-full ${tone === 'success' ? 'bg-emerald-50 text-emerald-600 ring-8 ring-emerald-50/50' : tone === 'attention' ? 'bg-amber-50 text-amber-700' : 'bg-stone-100 text-stone-500'}`}>
            <Icon className={`h-10 w-10 ${!result && reference && !error ? 'animate-spin' : ''}`} aria-hidden />
          </div>
          <p className="mt-6 text-xs font-bold uppercase tracking-widest text-stone-500">Tu compra</p>
          <h1 id="payment-result-title" className="mt-2 font-display text-3xl font-bold tracking-tight text-stone-950">{presentation?.title ?? (!reference ? 'Consultar compra' : error ? 'No pudimos consultar tu compra' : 'Consultando tu compra')}</h1>
          {presentation ? <p className="mt-3 text-sm leading-6 text-stone-600">{presentation.description}</p> : null}
        </header>
        {result && presentation ? <>
          <dl className="mt-7 rounded-2xl border border-stone-200 bg-stone-50 p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-sm text-stone-600">Pedido</dt><dd className="break-all text-sm font-semibold text-stone-950">{result.order.displayNumber}</dd></div>
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-sm text-stone-600">Total de la compra</dt><dd className="text-2xl font-bold tracking-tight text-stone-950">{formatMoney(result.order.totalCents, result.order.currencyCode)}</dd></div>
            {orderLabels[result.order.status] ? <div className="mt-4 border-t border-stone-200 pt-3"><dt className="text-xs text-stone-500">Estado del pedido</dt><dd className="mt-1 text-sm font-medium text-stone-700">{orderLabels[result.order.status]}</dd></div> : null}
          </dl>
          <div className={`mt-5 flex gap-3 rounded-2xl p-4 sm:p-5 ${presentation.whatsapp ? 'bg-emerald-50 text-emerald-950' : 'bg-stone-50 text-stone-800'}`}>
            {presentation.whatsapp ? <WhatsAppIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" /> : <ArrowUpRight className="mt-0.5 h-5 w-5 shrink-0 text-stone-500" aria-hidden />}
            <div><h2 className="text-sm font-bold">{presentation.nextTitle}</h2><p className={`mt-1.5 text-sm leading-6 ${presentation.whatsapp ? 'text-emerald-900' : 'text-stone-600'}`}>{presentation.nextDescription}</p>{presentation.whatsapp ? <p className="mt-2 text-xs leading-5 text-emerald-800">Si compraste fuera del horario de atención, te contactarán cuando el comercio vuelva a abrir.</p> : null}</div>
          </div>
        </> : null}
        {!reference ? <div className="mt-6"><ErrorPanel title="Acceso no disponible">La consulta temporal venció o pertenece a otro dispositivo. Consultá al comercio antes de repetir la compra.</ErrorPanel></div> : null}
        {error ? <div className="mt-5"><ErrorPanel title="No pudimos actualizar el estado">{error} {result ? 'El resumen muestra la última información disponible.' : ''}</ErrorPanel></div> : null}
        {canPay ? <div className="mt-6"><a className="button-primary min-h-12 w-full" href={result.payment.checkoutUrl!}><ExternalLink className="h-5 w-5" aria-hidden />Continuar en Mercado Pago</a><p className="mt-2 text-center text-xs leading-5 text-stone-500">Sólo si todavía no completaste el pago.</p></div> : null}
        {reference ? <button className="button-secondary mt-4 min-h-12 w-full" disabled={busy} onClick={() => void refresh()}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />{busy ? 'Consultando…' : 'Actualizar estado'}</button> : null}
        <Link className="mx-auto mt-6 flex min-h-11 w-fit items-center justify-center gap-2 text-sm font-semibold text-stone-600 underline underline-offset-4" to={commercePath(slug, 'store')}><ArrowLeft className="h-4 w-4" aria-hidden />Volver a la tienda</Link>
      </div>
    </section>
  </main>
}
