import { CheckCircle2, Clipboard, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { formatMoney } from '../../lib/money'
import { forgetOrderRecovery, readOrderRecovery, saveOrderRecovery } from '../../lib/order-recovery'
import { whatsappWebUrl } from '../../lib/phone'
import { supabase } from '../../lib/supabase/client'
import { generatedOrderSchema } from '../../lib/validation/schemas'
import { useCart } from '../cart/CartProvider'

export function OrderGeneratedPage() {
  const { restaurantSlug = '' } = useParams()
  return <OrderConfirmation key={restaurantSlug} slug={restaurantSlug} />
}

function OrderConfirmation({ slug }: { slug: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const cart = useCart()
  const [initial] = useState(() => generatedOrderSchema.safeParse(location.state))
  const [generated, setGenerated] = useState(() => initial.success ? initial.data : null)
  const [reference] = useState(() => readOrderRecovery(slug))
  const [recovering, setRecovering] = useState(!initial.success && Boolean(reference))
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoverable, setRecoverable] = useState(Boolean(reference))
  const [priceAccepted, setPriceAccepted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openingError, setOpeningError] = useState(false)
  const cartCleared = useRef(false)
  const openingRef = useRef(false)

  const recover = useCallback(async () => {
    if (!reference) return
    setRecovering(true); setRecoveryError(null)
    try {
      const result = await supabase.functions.invoke('recover-order', { body: { actionId: reference.actionId, recoveryToken: reference.token } })
      if (result.error) throw new Error('No pudimos recuperar la confirmación. Podés reintentar; si el plazo venció, consultá al comercio antes de crear otro pedido.')
      const parsed = generatedOrderSchema.safeParse(result.data)
      if (!parsed.success || parsed.data.order.actionId !== reference.actionId) throw new Error('La respuesta no pudo verificarse. Consultá al comercio antes de crear otro pedido.')
      setGenerated({ ...parsed.data, estimatedTotalCents: reference.estimatedTotalCents })
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : 'No pudimos recuperar la confirmación.')
    } finally { setRecovering(false) }
  }, [reference])

  useEffect(() => { if (!initial.success && reference) void recover() }, [initial.success, reference, recover])
  useEffect(() => {
    if (!generated) return
    setRecoverable(saveOrderRecovery(slug, generated))
  }, [generated, slug])
  useEffect(() => {
    if (!generated) return
    // Recovery may happen after the customer started another cart; preserve it.
    if (initial.success && !cartCleared.current) { cartCleared.current = true; cart.clear() }
    if (location.state !== null) void navigate(location.pathname, { replace: true, state: null })
  }, [cart, generated, initial.success, location.pathname, location.state, navigate])

  if (recovering && !generated) return <LoadingScreen label="Recuperando la confirmación…" />
  if (!generated) return <main className="page-shell py-16"><ErrorPanel title="Esta confirmación no está disponible">{recoveryError ?? 'El acceso temporal venció o no está guardado en este dispositivo. Revisá WhatsApp o consultá al comercio antes de generar otro pedido.'}<div className="mt-4 flex flex-wrap gap-3">{reference ? <button className="button-primary" disabled={recovering} onClick={() => void recover()}>Reintentar recuperación</button> : null}<Link className="button-secondary" to={`/r/${slug}`}>Volver al menú</Link></div></ErrorPanel></main>
  const orderResult = generated
  const stillPending = ['generated', 'whatsapp_opened'].includes(orderResult.order.status)
  const priceChanged = orderResult.estimatedTotalCents !== undefined && orderResult.estimatedTotalCents !== orderResult.order.totalCents
  const canShare = !priceChanged || priceAccepted
  const webUrl = whatsappWebUrl(orderResult.whatsapp.url, orderResult.whatsapp.message)
  const statusLabels = { accepted: 'aceptado', completed: 'entregado', cancelled: 'cancelado', expired: 'vencido', generated: 'generado', whatsapp_opened: 'pendiente de aceptación' }

  async function registerWhatsappOpened() {
    if (!orderResult.clientEventToken) return
    try {
      await Promise.race([
        supabase.functions.invoke('register-whatsapp-opened', { body: { actionId: orderResult.order.actionId, clientEventToken: orderResult.clientEventToken } }),
        new Promise((resolve) => window.setTimeout(resolve, 1800)),
      ])
    } catch { /* Telemetry must not prevent sending the confirmed message. */ }
  }
  async function openWhatsapp() {
    if (openingRef.current || !canShare) return
    openingRef.current = true; setOpening(true); setOpeningError(false)
    try {
      await registerWhatsappOpened()
      window.location.assign(orderResult.whatsapp.url)
    } catch { setOpeningError(true) }
    finally { openingRef.current = false; setOpening(false) }
  }
  async function copy() {
    if (!canShare) return
    try { await navigator.clipboard.writeText(orderResult.whatsapp.message); setCopied(true); setCopyError(false) }
    catch { setCopied(false); setCopyError(true) }
  }

  return <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,#ffe2d3,transparent_45%),#f7f4ef] p-4"><section className="w-full max-w-xl rounded-[2rem] bg-white p-6 text-center shadow-2xl shadow-stone-900/10 sm:p-9">
    <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" aria-hidden /><p className="mt-5 text-xs font-bold uppercase tracking-[.2em] text-orange-700">{initial.success ? 'Pedido generado' : 'Pedido recuperado'}</p><h1 className="mt-2 font-display text-4xl font-bold">{orderResult.order.displayNumber}</h1><p className="mt-3 text-lg font-bold">{formatMoney(orderResult.order.totalCents, orderResult.order.currencyCode)}</p>
    <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-stone-600">{stillPending ? 'Todavía falta enviarlo por WhatsApp. Luego, el comercio debe aceptarlo para que quede confirmado.' : `Este pedido ya está ${statusLabels[orderResult.order.status]}. Se recuperó el mismo pedido, sin crear otro.`}</p>
    {priceChanged ? <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-left" role="alert"><p>El total cambió desde la estimación de {formatMoney(orderResult.estimatedTotalCents!, orderResult.order.currencyCode)}. El total registrado es {formatMoney(orderResult.order.totalCents, orderResult.order.currencyCode)}.</p><label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={priceAccepted} onChange={event => setPriceAccepted(event.target.checked)} />Revisé el detalle y acepto el total actualizado antes de enviarlo.</label><p className="mt-2 text-xs">Si no lo aceptás, consultá al comercio por este número de pedido.</p></div> : null}
    <details className="mt-5 rounded-xl bg-stone-50 p-4 text-left" open={priceChanged}><summary className="cursor-pointer font-semibold">Detalle confirmado del pedido</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-6">{orderResult.whatsapp.message}</pre></details>
    <div className="mt-7 grid gap-3">{stillPending ? <div className="grid gap-3 sm:grid-cols-2"><button className="button-primary min-h-14" disabled={opening || !canShare} onClick={() => void openWhatsapp()}>{opening ? 'Abriendo WhatsApp…' : <><ExternalLink className="h-5 w-5" aria-hidden />Abrir WhatsApp</>}</button><a className={`button-secondary min-h-14 ${canShare ? '' : 'pointer-events-none opacity-50'}`} aria-disabled={!canShare} href={canShare ? webUrl : undefined} tabIndex={canShare ? 0 : -1} target="_blank" rel="noopener noreferrer" onClick={() => { if (canShare) void registerWhatsappOpened() }}><ExternalLink className="h-5 w-5" aria-hidden />Abrir WhatsApp Web</a></div> : null}<button className="button-secondary" disabled={!canShare} onClick={() => void copy()}><Clipboard className="h-4 w-4" aria-hidden />{copied ? 'Mensaje copiado' : 'Copiar mensaje'}</button>{copyError ? <p className="form-error" role="alert">No pudimos copiar el mensaje. Abrí WhatsApp para continuar.</p> : null}
      {openingError ? <p className="form-error" role="alert">No pudimos abrir WhatsApp. Podés reintentar, usar WhatsApp Web o copiar el mensaje.</p> : null}
      <p className="text-xs text-stone-500">{recoverable ? 'Podés recuperar esta confirmación en este dispositivo hasta 30 minutos después de generarla. Los datos del pedido no se guardan en el navegador.' : 'La recuperación temporal no está disponible en este dispositivo. Copiá el mensaje antes de cerrar esta pantalla.'}</p>
      {recoverable ? <button className="text-xs underline" onClick={() => { forgetOrderRecovery(slug); setRecoverable(false) }}>Quitar acceso guardado en este dispositivo</button> : null}
      <Link className="mt-2 text-sm font-semibold text-stone-600 underline" to={`/r/${slug}`}>Volver al menú</Link></div>
  </section></main>
}
