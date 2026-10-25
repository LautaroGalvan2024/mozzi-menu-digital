import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft, Bike, Check, ShoppingBag, Store } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { checkoutBusinessRequest, checkoutRequestFingerprint, clearCheckoutAttempt, getCheckoutAttemptKey, readCheckoutAttempt, recordCheckoutAttempt, type CheckoutBusinessRequest } from '../../lib/checkout-attempt'
import { env } from '../../lib/env'
import { formatMoney } from '../../lib/money'
import { estimateAdjustment } from '../../lib/orders'
import { saveOrderRecovery } from '../../lib/order-recovery'
import { calculateCartLineTotal } from '../../lib/quantity-pricing'
import { supabase } from '../../lib/supabase/client'
import { checkoutSchema, generatedOrderSchema, type CheckoutValues } from '../../lib/validation/schemas'
import type { CartLine, GeneratedOrder } from '../../types/domain'
import { useCart } from '../cart/CartProvider'
import { validateCartLines } from '../cart/cartValidation'
import { usePublicMenu } from '../public-menu/usePublicMenu'

const zodErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

const emptyCheckoutValues: CheckoutValues = {
  customerName: '',
  customerPhone: '',
  fulfillmentType: 'pickup',
  deliveryZoneId: '',
  address: '',
  city: '',
  neighborhood: '',
  floor: '',
  apartment: '',
  reference: '',
  paymentMethodId: '',
  notes: '',
  website: '',
}

const publicOrderErrors: Readonly<Record<string, string>> = {
  INVENTORY_PAUSED: 'El comercio pausó temporalmente la recepción de pedidos. Consultá al comercio.',
  INVENTORY_CUTOVER: 'El comercio está actualizando sus existencias. Volvé a intentar en unos minutos.',
  INVENTORY_NOT_INITIALIZED: 'El comercio debe revisar las existencias antes de recibir este pedido. Consultá al comercio.',
  INSUFFICIENT_STOCK: 'No hay existencias suficientes para este pedido. Revisá las cantidades o consultá al comercio.',
  IDEMPOTENCY_CONFLICT: 'Este intento corresponde a otros datos. Recuperá los datos originales o consultá al comercio antes de iniciar otro pedido.',
  RATE_LIMITED: 'Demasiados intentos. Esperá unos minutos y volvé a intentar.',
  STALE_FORM: 'El formulario venció. Esperá un segundo y volvé a confirmar.',
  CAPTCHA_REQUIRED: 'Volvé a completar el control anti-spam.',
  CAPTCHA_FAILED: 'Volvé a completar el control anti-spam.',
  CAPTCHA_UNAVAILABLE: 'Volvé a completar el control anti-spam.',
  RESTAURANT_NOT_FOUND: 'El comercio ya no está disponible.',
  RESTAURANT_NOT_ACTIVE: 'El comercio ya no está disponible para recibir pedidos.',
  MENU_NOT_PUBLISHED: 'El menú ya no está publicado.',
  RESTAURANT_CLOSED: 'El comercio cerró antes de confirmar el pedido.',
  FULFILLMENT_UNAVAILABLE: 'La modalidad elegida ya no está disponible.',
  DELIVERY_ZONE_INVALID: 'La zona de envío ya no está disponible.',
  PAYMENT_METHOD_INVALID: 'El medio de pago ya no está disponible.',
  PRODUCT_UNAVAILABLE: 'Uno de los productos ya no está disponible. Volvé al carrito para revisarlo.',
  OPTION_INVALID: 'Una opción elegida ya no está disponible. Volvé al carrito para revisarla.',
  OPTION_SELECTION_INVALID: 'Revisá las opciones requeridas de los productos.',
  MINIMUM_ORDER_NOT_MET: 'El pedido no alcanza el mínimo actualizado.',
}

export function CheckoutPage() {
  const { restaurantSlug } = useParams()
  const menu = usePublicMenu(restaurantSlug)
  const cart = useCart()
  const { activateRestaurant, reconcileProducts } = cart
  const navigate = useNavigate()
  const mountedAttempt = useRef<{ fingerprint: string; key: string; business: CheckoutBusinessRequest; estimatedTotalCents: number; summary: CartLine[] } | null>(null)
  const busy = useRef(false)
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState(() => {
    try { const saved = restaurantSlug ? readCheckoutAttempt(restaurantSlug) : null; return Boolean(saved && saved.status !== 'rejected') } catch { return true }
  })
  const [locked, setLocked] = useState(false)
  const [absenceConfirmed, setAbsenceConfirmed] = useState(false)
  const formStartedAt = useRef(new Date().toISOString())
  const formRestaurantId = useRef<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileReset, setTurnstileReset] = useState(0)
  const form = useForm<CheckoutValues>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: emptyCheckoutValues,
  })
  const fulfillmentType = form.watch('fulfillmentType')
  const paymentMethodId = form.watch('paymentMethodId')
  const deliveryZoneId = form.watch('deliveryZoneId')

  useEffect(() => { if (restaurantSlug) activateRestaurant(restaurantSlug) }, [activateRestaurant, restaurantSlug])
  useEffect(() => {
    if (!menu.data || pending || cart.restaurantSlug !== menu.data.restaurant.slug) return
    reconcileProducts(menu.data.categories.flatMap((category) => category.products))
  }, [cart.restaurantSlug, menu.data, menu.dataUpdatedAt, pending, reconcileProducts])
  useEffect(() => {
    if (!menu.data) return
    const restaurant = menu.data.restaurant
    if (formRestaurantId.current !== restaurant.id) {
      formRestaurantId.current = restaurant.id
      mountedAttempt.current = null
      setLocked(false)
      setAbsenceConfirmed(false)
      formStartedAt.current = new Date().toISOString()
      setServerError(null)
      try {
        const saved = readCheckoutAttempt(restaurant.slug)
        setPending(Boolean(saved && saved.status !== 'rejected'))
      } catch (error) {
        setPending(true)
        setServerError(error instanceof Error ? error.message : 'No pudimos recuperar el intento anterior.')
      }
      setTurnstileToken(null)
      setTurnstileReset((value) => value + 1)
      form.reset({
        ...emptyCheckoutValues,
        fulfillmentType: restaurant.pickupEnabled ? 'pickup' : 'delivery',
        paymentMethodId: menu.data.paymentMethods[0]?.id ?? '',
      })
      return
    }

    if (pending) return
    const currentPayment = form.getValues('paymentMethodId')
    if (!menu.data.paymentMethods.some((method) => method.id === currentPayment)) {
      form.setValue('paymentMethodId', menu.data.paymentMethods[0]?.id ?? '')
    }
    const currentFulfillment = form.getValues('fulfillmentType')
    if (currentFulfillment === 'pickup' && !restaurant.pickupEnabled && restaurant.deliveryEnabled) {
      form.setValue('fulfillmentType', 'delivery')
    } else if (currentFulfillment === 'delivery' && !restaurant.deliveryEnabled && restaurant.pickupEnabled) {
      form.setValue('fulfillmentType', 'pickup')
    }
  }, [form, menu.data, pending])

  const selectedPayment = menu.data?.paymentMethods.find((method) => method.id === paymentMethodId)
  const selectedZone = menu.data?.deliveryZones.find((zone) => zone.id === deliveryZoneId)
  const deliveryFee = fulfillmentType === 'delivery' && selectedZone ? (selectedZone.freeShippingFromCents !== null && cart.subtotalCents >= selectedZone.freeShippingFromCents ? 0 : selectedZone.deliveryFeeCents) : 0
  const adjustment = selectedPayment ? estimateAdjustment(selectedPayment, cart.subtotalCents, deliveryFee) : 0
  const estimatedTotal = Math.max(0, cart.subtotalCents + deliveryFee + adjustment)
  const lineIssues = useMemo(() => validateCartLines(cart.lines, menu.data?.categories.flatMap(category => category.products) ?? []), [cart.lines, menu.data])
  const invalidCart = [...lineIssues.values()].some(issues => issues.length > 0)
  const eligible = useMemo(() => {
    if (!menu.data || menu.isFetching || menu.error || invalidCart) return false
    const zoneMinimum = fulfillmentType === 'delivery' ? selectedZone?.minimumOrderCents ?? 0 : 0
    const minimum = Math.max(menu.data.restaurant.minimumOrderCents, zoneMinimum)
    const antiSpamReady = !env.isTurnstileConfigured || Boolean(turnstileToken)
    const fulfillmentReady = fulfillmentType === 'pickup'
      ? menu.data.restaurant.pickupEnabled
      : menu.data.restaurant.deliveryEnabled && Boolean(selectedZone)
    return menu.data.restaurant.isOpen && Boolean(selectedPayment) && fulfillmentReady && cart.subtotalCents >= minimum && cart.itemCount <= 100 && cart.lines.length <= 25 && antiSpamReady
  }, [cart.itemCount, cart.lines.length, cart.subtotalCents, fulfillmentType, invalidCart, menu.data, menu.error, menu.isFetching, selectedPayment, selectedZone, turnstileToken])

  if (menu.isLoading) return <LoadingScreen label="Revalidando el menú…" />
  if (!menu.data) return <main className="page-shell py-16"><ErrorPanel>No pudimos cargar los datos necesarios para confirmar.</ErrorPanel></main>
  if (cart.restaurantSlug !== menu.data.restaurant.slug) return <LoadingScreen label="Recuperando tu carrito…" />
  if (cart.lines.length === 0 && !pending) return <Navigate to={`/r/${restaurantSlug}/carrito`} replace />
  const restaurant = menu.data.restaurant

  const send = async (values: CheckoutValues) => {
    if (busy.current) return
    busy.current = true
    setSending(true)
    setServerError(null)
    let requestSent = false
    try {
      if (!pending && invalidCart) { setServerError('El carrito tiene productos u opciones que requieren revisión. Volvé al carrito para reconfigurarlos.'); return }
      if (!pending && !eligible) { setServerError('El comercio está cerrado o el pedido no alcanza el mínimo.'); return }
      if (env.isTurnstileConfigured && !turnstileToken) { setServerError(publicOrderErrors.CAPTCHA_REQUIRED!); return }
      const saved = readCheckoutAttempt(restaurant.slug)
      const previouslyUncertain = Boolean(saved && saved.status !== 'rejected')
      const business = mountedAttempt.current?.business ?? checkoutBusinessRequest(restaurant.slug, values, cart.lines)
      const fingerprint = await checkoutRequestFingerprint(business)
      if (saved?.version === 2 && saved.status === 'uncertain' && saved.fingerprint !== fingerprint) {
        setServerError('Los datos no coinciden con el intento pendiente. Reponé el mismo carrito, tus datos, entrega, pago y observaciones; o consultá al comercio. No se envió otro pedido.')
        return
      }
      const key = getCheckoutAttemptKey(restaurant.slug, fingerprint)
      const originalEstimate = mountedAttempt.current?.estimatedTotalCents ?? (previouslyUncertain ? saved?.estimatedTotalCents : undefined) ?? estimatedTotal
      recordCheckoutAttempt(restaurant.slug, key, fingerprint, 'uncertain', originalEstimate)
      mountedAttempt.current = { business, fingerprint, key, estimatedTotalCents: originalEstimate, summary: mountedAttempt.current?.summary ?? structuredClone(cart.lines) }
      setLocked(true)
      setPending(true)
      requestSent = true
      const { data, error } = await supabase.functions.invoke('create-order', { body: {
        ...business, idempotencyKey: key,
        antiSpam: { honeypot: values.website, formStartedAt: formStartedAt.current, ...(turnstileToken ? { turnstileToken } : {}) },
      } })
      if (error) {
        let message = 'No pudimos confirmar si el pedido se creó. Reintentá el mismo pedido o consultá al comercio.'
        const context = (error as { context?: unknown }).context
        if (context instanceof Response) {
          try {
            const parsedError = zodErrorResponse.safeParse(await context.clone().json())
            const code = parsedError.success ? parsedError.data.error.code : ''
            if (publicOrderErrors[code]) {
              message = publicOrderErrors[code]
              if (!previouslyUncertain && context.status >= 400 && context.status < 500 && code !== 'IDEMPOTENCY_CONFLICT') {
                recordCheckoutAttempt(restaurant.slug, key, fingerprint, 'rejected')
                mountedAttempt.current = null
                setLocked(false)
                setPending(false)
              }
            }
          } catch {
            // An unreadable response cannot prove that the transaction failed.
          }
        }
        setServerError(message)
        return
      }
      const parsed = generatedOrderSchema.safeParse(data)
      if (!parsed.success) { setServerError('No pudimos confirmar la respuesta. Recuperá el mismo pedido: conservamos su clave para evitar duplicarlo.'); return }
      const generated: GeneratedOrder = { ...parsed.data, estimatedTotalCents: originalEstimate }
      saveOrderRecovery(restaurant.slug, generated)
      try { clearCheckoutAttempt(restaurant.slug) } catch { /* Confirmed response is still safe to show. */ }
      navigate(`/r/${restaurant.slug}/pedido-generado`, { state: generated, replace: true })
    } catch (error) {
      setServerError(requestSent ? 'No pudimos confirmar si el pedido se creó. Reintentá el mismo pedido o consultá al comercio.' : error instanceof Error ? error.message : 'No pudimos preparar el pedido. No se envió.')
    } finally {
      if (requestSent) {
        formStartedAt.current = new Date().toISOString()
        setTurnstileToken(null)
        setTurnstileReset((value) => value + 1)
      }
      busy.current = false
      setSending(false)
    }
  }
  const submit = form.handleSubmit(send)
  const startAnother = () => {
    if (!absenceConfirmed || busy.current) return
    try {
      clearCheckoutAttempt(restaurant.slug)
      mountedAttempt.current = null
      setLocked(false)
      setPending(false)
      setAbsenceConfirmed(false)
      setServerError(null)
    } catch { setServerError('No pudimos liberar el intento. Revisá el almacenamiento del navegador antes de continuar.') }
  }

  return (
    <main className="min-h-screen bg-stone-100 py-6 sm:py-10"><div className="page-shell max-w-5xl"><Link to={`/r/${restaurant.slug}/carrito`} className="inline-flex items-center gap-2 text-sm font-semibold text-stone-600"><ArrowLeft className="h-4 w-4" aria-hidden />Volver al carrito</Link><div className="mt-5"><h1 className="font-display text-4xl font-bold">Finalizar pedido</h1><p className="mt-2 text-stone-600">El comercio debe aceptar el pedido desde el enlace seguro que recibirá por WhatsApp.</p></div>
      {pending ? <section className="form-card mt-5 border border-amber-300" aria-label="Pedido pendiente de recuperar"><h2 className="font-semibold">Hay un intento pendiente de confirmar</h2><p className="mt-2 text-sm">{locked ? 'Conservamos los datos enviados. Recuperá el mismo pedido aunque haya pasado tiempo; el reintento no genera otro.' : 'Volvé a ingresar exactamente los datos originales. Por privacidad, este intento sólo conserva una huella y su clave; no guarda tus datos personales.'}</p><p className="mt-2 text-sm">Si ya no recordás los datos o querés cambiarlos, <a className="underline" href={`https://wa.me/${restaurant.whatsappPhone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">consultá al comercio</a> antes de comenzar otro pedido.</p><label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={absenceConfirmed} disabled={sending} onChange={(event) => setAbsenceConfirmed(event.target.checked)} />Ya confirmé con el comercio que el pedido anterior no existe.</label><button type="button" className="button-secondary mt-3" disabled={!absenceConfirmed || sending} onClick={startAnother}>Iniciar otro intento</button></section> : null}
      {!pending && menu.isFetching ? <p className="mt-4 text-sm" role="status">Actualizando precios y disponibilidad…</p> : null}
      {!pending && menu.error ? <p className="form-error mt-4" role="alert">No pudimos actualizar el menú. <button className="underline" onClick={() => void menu.refetch()}>Volver a intentar</button></p> : null}
      <form className="mt-8 grid gap-6 lg:grid-cols-[1fr_350px]" onSubmit={(event) => { if (locked) { event.preventDefault(); void send(form.getValues()) } else void submit(event) }} noValidate><div className="space-y-5"><fieldset disabled={locked || sending} className="space-y-5"><section className="form-card"><h2 className="form-card-title">Productos y opciones</h2><ul className="space-y-3">{(mountedAttempt.current?.summary ?? cart.lines).map(line => <li key={line.key}><div className="flex justify-between gap-3"><strong>{line.quantity} × {line.productName}</strong><span>{formatMoney(calculateCartLineTotal(line), restaurant.currencyCode, restaurant.locale)}</span></div>{line.selectedOptions.length ? <p className="text-sm text-stone-600">{line.selectedOptions.map(option => option.name).join(' · ')}</p> : null}{line.notes ? <p className="text-sm italic text-stone-600">{line.notes}</p> : null}{!pending ? (lineIssues.get(line.key) ?? []).map((issue, index) => <p className="mt-1 text-sm text-amber-800" key={index}>{issue.message}</p>) : null}</li>)}</ul>{invalidCart && !pending ? <Link className="mt-3 inline-block font-semibold underline" to={`/r/${restaurant.slug}/carrito`}>Revisar productos del carrito</Link> : null}</section><section className="form-card"><h2 className="form-card-title">Tus datos</h2><div className="grid gap-4 sm:grid-cols-2"><label className="field"><span>Nombre y apellido</span><input autoComplete="name" {...form.register('customerName')} />{form.formState.errors.customerName ? <small>{form.formState.errors.customerName.message}</small> : null}</label><label className="field"><span>Teléfono</span><input type="tel" autoComplete="tel" {...form.register('customerPhone')} />{form.formState.errors.customerPhone ? <small>{form.formState.errors.customerPhone.message}</small> : null}</label></div></section>
        <section className="form-card"><h2 className="form-card-title">¿Cómo lo recibís?</h2><div className="grid gap-3 sm:grid-cols-2">{restaurant.pickupEnabled ? <label className={`choice-card ${fulfillmentType === 'pickup' ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value="pickup" {...form.register('fulfillmentType')} /><Store aria-hidden /><span><strong>Retiro</strong><small>{restaurant.address}</small></span>{fulfillmentType === 'pickup' ? <Check className="ml-auto" aria-hidden /> : null}</label> : null}{restaurant.deliveryEnabled ? <label className={`choice-card ${fulfillmentType === 'delivery' ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value="delivery" {...form.register('fulfillmentType')} /><Bike aria-hidden /><span><strong>Envío</strong><small>Elegí tu zona</small></span>{fulfillmentType === 'delivery' ? <Check className="ml-auto" aria-hidden /> : null}</label> : null}</div>
        {fulfillmentType === 'delivery' ? <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="field sm:col-span-2"><span>Zona</span><select {...form.register('deliveryZoneId')}><option value="">Seleccionar</option>{menu.data.deliveryZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name} · {formatMoney(zone.deliveryFeeCents, restaurant.currencyCode, restaurant.locale)}</option>)}</select>{form.formState.errors.deliveryZoneId ? <small>{form.formState.errors.deliveryZoneId.message}</small> : null}</label><label className="field sm:col-span-2"><span>Dirección</span><input autoComplete="street-address" {...form.register('address')} />{form.formState.errors.address ? <small>{form.formState.errors.address.message}</small> : null}</label><label className="field"><span>Ciudad</span><input autoComplete="address-level2" {...form.register('city')} />{form.formState.errors.city ? <small>{form.formState.errors.city.message}</small> : null}</label><label className="field"><span>Barrio</span><input {...form.register('neighborhood')} /></label><label className="field"><span>Piso</span><input {...form.register('floor')} /></label><label className="field"><span>Departamento</span><input {...form.register('apartment')} /></label><label className="field sm:col-span-2"><span>Referencia</span><input {...form.register('reference')} /></label></div> : null}</section>
        <section className="form-card"><h2 className="form-card-title">Medio de pago</h2><div className="space-y-2">{menu.data.paymentMethods.map((method) => <label key={method.id} className={`choice-card ${paymentMethodId === method.id ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value={method.id} {...form.register('paymentMethodId')} /><ShoppingBag aria-hidden /><span><strong>{method.name}</strong><small>{method.description}{method.adjustmentType !== 'none' ? ` · ${method.adjustmentBps / 100}% ${method.adjustmentType === 'discount' ? 'de descuento' : 'de recargo'}` : ''}</small></span>{paymentMethodId === method.id ? <Check className="ml-auto" aria-hidden /> : null}</label>)}</div>{form.formState.errors.paymentMethodId ? <p className="form-error">{form.formState.errors.paymentMethodId.message}</p> : null}</section>
        <section className="form-card"><label className="field"><span>Observaciones generales</span><textarea rows={3} maxLength={500} {...form.register('notes')} /></label><label className="absolute -left-[10000px]" aria-hidden="true"><span>Sitio web</span><input tabIndex={-1} autoComplete="off" {...form.register('website')} /></label></section></fieldset>{env.isTurnstileConfigured?<section className="form-card"><h2 className="form-card-title">Control anti-spam</h2><div className="mt-4"><TurnstileWidget key={turnstileReset} siteKey={env.turnstileSiteKey} onTokenChange={setTurnstileToken}/></div></section>:null}</div>
        <aside className="h-fit rounded-3xl bg-stone-950 p-6 text-white lg:sticky lg:top-6"><h2 className="font-display text-xl font-bold">Total estimado</h2><dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between text-stone-300"><dt>Subtotal</dt><dd>{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</dd></div>{adjustment !== 0 ? <div className="flex justify-between text-stone-300"><dt>{adjustment < 0 ? 'Descuento' : 'Recargo'}</dt><dd>{formatMoney(adjustment, restaurant.currencyCode, restaurant.locale)}</dd></div> : null}<div className="flex justify-between text-stone-300"><dt>Envío</dt><dd>{deliveryFee === 0 ? 'Sin cargo' : formatMoney(deliveryFee, restaurant.currencyCode, restaurant.locale)}</dd></div><div className="flex justify-between border-t border-stone-700 pt-4 text-lg font-bold"><dt>Total</dt><dd>{formatMoney(estimatedTotal, restaurant.currencyCode, restaurant.locale)}</dd></div></dl><p className="mt-4 text-xs leading-5 text-stone-400">El servidor recalcula precios, disponibilidad y horario antes de crear el pedido.</p>{serverError ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-xs text-red-100" role="alert">{serverError}</p> : null}<button className="button-primary mt-5 w-full" disabled={sending || (pending ? (env.isTurnstileConfigured && !turnstileToken) || (!locked && cart.lines.length === 0) : !eligible)} type="submit">{sending ? 'Consultando pedido…' : pending ? 'Recuperar mismo pedido' : 'Generar pedido'}</button><p className="mt-3 text-center text-xs text-amber-300">El pedido queda confirmado cuando el comercio lo acepte.</p></aside></form></div></main>
  )
}
