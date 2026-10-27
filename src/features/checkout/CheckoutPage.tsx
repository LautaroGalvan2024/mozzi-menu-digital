import { commercePath, useCommerceChannel } from '../../lib/commerce-channel'
import { StorePurchaseSteps } from '../store/StorePurchaseSteps'
import { paymentSessionSchema, savePaymentRecovery } from '../store/payment-recovery'
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

// Online requests are priced with the provider method chosen by the server.
const ONLINE_METHOD_ID = '00000000-0000-4000-8000-000000000001'

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
  STORE_NOT_PUBLISHED: 'La tienda ya no está publicada.',
  CHECKOUT_DISABLED: 'Esta forma de compra ya no está habilitada.',
  PAYMENT_PROVIDER_UNAVAILABLE: 'Mercado Pago no respondió. Reintentá este mismo pedido para evitar una compra duplicada.',
  PAYMENT_PREPARING: 'Estamos preparando el pago. Reintentá este mismo pedido en unos segundos.',
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
  const channel = useCommerceChannel()
  const menu = usePublicMenu(restaurantSlug, channel)
  const cart = useCart()
  const { activateRestaurant, reconcileProducts } = cart
  const navigate = useNavigate()
  const mountedAttempt = useRef<{ fingerprint: string; key: string; business: CheckoutBusinessRequest; estimatedTotalCents: number; summary: CartLine[] } | null>(null)
  const busy = useRef(false)
  const [sending, setSending] = useState(false)
  const [checkoutMode, setCheckoutMode] = useState<'whatsapp' | 'online'>('whatsapp')
  const [pending, setPending] = useState(() => {
    try { const saved = restaurantSlug ? readCheckoutAttempt(restaurantSlug, channel) : null; return Boolean(saved && saved.status !== 'rejected') } catch { return true }
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

  useEffect(() => { if (restaurantSlug) activateRestaurant(restaurantSlug, channel) }, [activateRestaurant, restaurantSlug, channel])
  useEffect(() => {
    if (!menu.data || pending || cart.restaurantSlug !== menu.data.restaurant.slug || (cart.channel ?? 'menu') !== channel) return
    reconcileProducts(menu.data.categories.flatMap((category) => category.products))
  }, [cart.restaurantSlug, cart.channel, channel, menu.data, menu.dataUpdatedAt, pending, reconcileProducts])
  useEffect(() => {
    if (!menu.data) return
    const restaurant = menu.data.restaurant
    const scopeId = `${restaurant.id}:${channel}`
    const availableMethods = menu.data.paymentMethods.filter(method => method.provider !== 'mercadopago')
    if (formRestaurantId.current !== scopeId) {
      formRestaurantId.current = scopeId
      let initialMode: 'whatsapp' | 'online' = channel === 'store' && restaurant.storeCheckoutWhatsappEnabled === false ? 'online' : 'whatsapp'
      try { initialMode = readCheckoutAttempt(restaurant.slug, channel)?.checkoutMode ?? initialMode } catch { /* Recovery error is displayed below. */ }
      setCheckoutMode(initialMode)
      mountedAttempt.current = null
      setLocked(false)
      setAbsenceConfirmed(false)
      formStartedAt.current = new Date().toISOString()
      setServerError(null)
      try {
        const saved = readCheckoutAttempt(restaurant.slug, channel)
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
        paymentMethodId: initialMode === 'online' ? ONLINE_METHOD_ID : availableMethods[0]?.id ?? '',
      })
      return
    }

    if (pending) return
    const currentPayment = form.getValues('paymentMethodId')
    if (checkoutMode === 'online') {
      if (currentPayment !== ONLINE_METHOD_ID) form.setValue('paymentMethodId', ONLINE_METHOD_ID)
    } else if (!availableMethods.some((method) => method.id === currentPayment)) {
      form.setValue('paymentMethodId', availableMethods[0]?.id ?? '')
    }
    const currentFulfillment = form.getValues('fulfillmentType')
    if (currentFulfillment === 'pickup' && !restaurant.pickupEnabled && restaurant.deliveryEnabled) {
      form.setValue('fulfillmentType', 'delivery')
    } else if (currentFulfillment === 'delivery' && !restaurant.deliveryEnabled && restaurant.pickupEnabled) {
      form.setValue('fulfillmentType', 'pickup')
    }
  }, [form, menu.data, pending, channel, checkoutMode])

  const selectedPayment = checkoutMode === 'online' ? undefined : menu.data?.paymentMethods.find((method) => method.id === paymentMethodId && method.provider !== 'mercadopago')
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
    const acceptsOrders = menu.data.restaurant.acceptsOrders ?? menu.data.restaurant.isOpen
    const paymentReady = checkoutMode === 'online' ? channel === 'store' && menu.data.restaurant.storeCheckoutOnlineEnabled === true : Boolean(selectedPayment) && (channel === 'menu' || menu.data.restaurant.storeCheckoutWhatsappEnabled !== false)
    return acceptsOrders && paymentReady && fulfillmentReady && cart.subtotalCents >= minimum && cart.itemCount <= 100 && cart.lines.length <= 25 && antiSpamReady
  }, [cart.itemCount, cart.lines.length, cart.subtotalCents, fulfillmentType, invalidCart, menu.data, menu.error, menu.isFetching, selectedPayment, selectedZone, turnstileToken, checkoutMode, channel])

  if (menu.isLoading) return <LoadingScreen label="Revalidando el menú…" />
  if (!menu.data) return <main className="page-shell py-16"><ErrorPanel>No pudimos cargar los datos necesarios para confirmar.</ErrorPanel></main>
  if (cart.restaurantSlug !== menu.data.restaurant.slug || (cart.channel ?? 'menu') !== channel) return <LoadingScreen label="Recuperando tu carrito…" />
  if (cart.lines.length === 0 && !pending) return <Navigate to={commercePath(restaurantSlug ?? '', channel, '/carrito')} replace />
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
      const saved = readCheckoutAttempt(restaurant.slug, channel)
      const previouslyUncertain = Boolean(saved && saved.status !== 'rejected')
      const business = mountedAttempt.current?.business ?? checkoutBusinessRequest(restaurant.slug, values, cart.lines, channel, checkoutMode)
      const fingerprint = await checkoutRequestFingerprint(business)
      if (saved?.version === 2 && saved.status === 'uncertain' && saved.fingerprint !== fingerprint) {
        setServerError('Los datos no coinciden con el intento pendiente. Reponé el mismo carrito, tus datos, entrega, pago y observaciones; o consultá al comercio. No se envió otro pedido.')
        return
      }
      const key = getCheckoutAttemptKey(restaurant.slug, fingerprint, Date.now(), undefined, channel)
      const originalEstimate = mountedAttempt.current?.estimatedTotalCents ?? (previouslyUncertain ? saved?.estimatedTotalCents : undefined) ?? estimatedTotal
      recordCheckoutAttempt(restaurant.slug, key, fingerprint, 'uncertain', originalEstimate, channel, checkoutMode)
      mountedAttempt.current = { business, fingerprint, key, estimatedTotalCents: originalEstimate, summary: mountedAttempt.current?.summary ?? structuredClone(cart.lines) }
      setLocked(true)
      setPending(true)
      requestSent = true
      const { data, error } = await supabase.functions.invoke(checkoutMode === 'online' ? 'create-payment' : 'create-order', { body: {
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
                recordCheckoutAttempt(restaurant.slug, key, fingerprint, 'rejected', undefined, channel)
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
      if (checkoutMode === 'online') {
        const payment = paymentSessionSchema.safeParse(data)
        if (!payment.success) { setServerError('No pudimos confirmar la respuesta del pago. Reintentá el mismo pedido; conservamos su clave.'); return }
        if (!payment.data.payment.checkoutUrl && ['created', 'pending'].includes(payment.data.payment.status)) { setServerError('El pago todavía se está preparando. Reintentá el mismo pedido en unos segundos.'); return }
        if (!savePaymentRecovery(restaurant.slug, payment.data)) { setServerError('No pudimos guardar el acceso a tu compra. Habilitá el almacenamiento del navegador y reintentá este mismo pedido antes de pagar.'); return }
        try { clearCheckoutAttempt(restaurant.slug, channel) } catch { /* The confirmed payment has its own recovery capability. */ }
        cart.clear()
        navigate(commercePath(restaurant.slug, 'store', '/pago'), { state: payment.data, replace: true })
        return
      }
      const parsed = generatedOrderSchema.safeParse(data)
      if (!parsed.success) { setServerError('No pudimos confirmar la respuesta. Recuperá el mismo pedido: conservamos su clave para evitar duplicarlo.'); return }
      const generated: GeneratedOrder = { ...parsed.data, estimatedTotalCents: originalEstimate }
      saveOrderRecovery(restaurant.slug, generated, channel)
      try { clearCheckoutAttempt(restaurant.slug, channel) } catch { /* Confirmed response is still safe to show. */ }
      navigate(commercePath(restaurant.slug, channel, '/pedido-generado'), { state: generated, replace: true })
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
      clearCheckoutAttempt(restaurant.slug, channel)
      mountedAttempt.current = null
      setLocked(false)
      setPending(false)
      setAbsenceConfirmed(false)
      setServerError(null)
    } catch { setServerError('No pudimos liberar el intento. Revisá el almacenamiento del navegador antes de continuar.') }
  }

  return (
    <main className={`min-h-screen py-6 sm:py-10 ${channel === 'store' ? 'bg-[#f7f5f2]' : 'bg-stone-100'}`}><div className="page-shell max-w-5xl"><Link to={commercePath(restaurant.slug, channel, '/carrito')} className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-stone-600"><ArrowLeft className="h-4 w-4" aria-hidden />Volver al carrito</Link>{channel === 'store' ? <StorePurchaseSteps slug={restaurant.slug} current={2} /> : null}<div className="mt-5"><h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Finalizar pedido</h1><p className="mt-2 text-stone-600">{channel === 'store' ? 'Completá tus datos y elegí cómo recibir y pagar tu compra.' : 'El comercio debe aceptar el pedido desde el enlace seguro que recibirá por WhatsApp.'}</p></div>
      {pending ? <section className="form-card mt-5 border border-amber-300" aria-label="Pedido pendiente de recuperar"><h2 className="font-semibold">Hay un intento pendiente de confirmar</h2><p className="mt-2 text-sm">{locked ? 'Conservamos los datos enviados. Recuperá el mismo pedido aunque haya pasado tiempo; el reintento no genera otro.' : 'Volvé a ingresar los mismos datos de tu compra para recuperar ese pedido. No guardamos tus datos personales en este dispositivo.'}</p><p className="mt-2 text-sm">Si ya no recordás los datos o querés cambiarlos, <a className="underline" href={`https://wa.me/${restaurant.whatsappPhone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">consultá al comercio</a> antes de comenzar otro pedido.</p><label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={absenceConfirmed} disabled={sending} onChange={(event) => setAbsenceConfirmed(event.target.checked)} />Ya confirmé con el comercio que el pedido anterior no existe.</label><button type="button" className="button-secondary mt-3" disabled={!absenceConfirmed || sending} onClick={startAnother}>Iniciar otro intento</button></section> : null}
      {!pending && menu.isFetching ? <p className="mt-4 text-sm" role="status">Actualizando precios y disponibilidad…</p> : null}
      {!pending && menu.error ? <p className="form-error mt-4" role="alert">No pudimos actualizar el catálogo. <button className="underline" onClick={() => void menu.refetch()}>Volver a intentar</button></p> : null}
      <form className="mt-8 grid gap-6 lg:grid-cols-[1fr_350px]" onSubmit={(event) => { if (locked) { event.preventDefault(); void send(form.getValues()) } else void submit(event) }} noValidate><div className="space-y-5"><fieldset disabled={locked || sending} className="space-y-5"><section className="form-card"><h2 className="form-card-title">{channel === 'store' ? 'Tu compra' : 'Productos y opciones'}</h2><ul className="mt-4 space-y-4">{(mountedAttempt.current?.summary ?? cart.lines).map(line => <li key={line.key}><div className="flex justify-between gap-3"><strong>{line.quantity} × {line.productName}</strong><span>{formatMoney(calculateCartLineTotal(line), restaurant.currencyCode, restaurant.locale)}</span></div>{line.selectedOptions.length ? <p className="text-sm text-stone-600">{line.selectedOptions.map(option => option.name).join(' · ')}</p> : null}{line.notes ? <p className="text-sm italic text-stone-600">{line.notes}</p> : null}{!pending ? (lineIssues.get(line.key) ?? []).map((issue, index) => <p className="mt-1 text-sm text-amber-800" key={index}>{issue.message}</p>) : null}</li>)}</ul>{invalidCart && !pending ? <Link className="mt-3 inline-block font-semibold underline" to={commercePath(restaurant.slug, channel, '/carrito')}>Revisar productos del carrito</Link> : null}</section><section className="form-card"><h2 className="form-card-title">Tus datos</h2><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="field"><span>Nombre y apellido</span><input autoComplete="name" {...form.register('customerName')} />{form.formState.errors.customerName ? <small>{form.formState.errors.customerName.message}</small> : null}</label><label className="field"><span>Teléfono</span><input type="tel" inputMode="tel" autoComplete="tel" placeholder="Ej.: +54 9 11 2345 6789" aria-describedby="checkout-phone-help" {...form.register('customerPhone')} />{form.formState.errors.customerPhone ? <small>{form.formState.errors.customerPhone.message}</small> : null}</label></div><p id="checkout-phone-help" className="mt-3 text-xs leading-5 text-stone-600">Ingresá tu número de WhatsApp con código de país y de área. El comercio lo usará para coordinar los detalles de tu pedido.</p></section>
        <section className="form-card"><h2 className="form-card-title">¿Cómo lo recibís?</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{restaurant.pickupEnabled ? <label className={`choice-card ${fulfillmentType === 'pickup' ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value="pickup" {...form.register('fulfillmentType')} /><Store aria-hidden /><span><strong>Retiro</strong><small>{restaurant.address}</small></span>{fulfillmentType === 'pickup' ? <Check className="ml-auto" aria-hidden /> : null}</label> : null}{restaurant.deliveryEnabled ? <label className={`choice-card ${fulfillmentType === 'delivery' ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value="delivery" {...form.register('fulfillmentType')} /><Bike aria-hidden /><span><strong>Envío</strong><small>Elegí tu zona</small></span>{fulfillmentType === 'delivery' ? <Check className="ml-auto" aria-hidden /> : null}</label> : null}</div>
        {fulfillmentType === 'delivery' ? <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="field sm:col-span-2"><span>Zona</span><select {...form.register('deliveryZoneId')}><option value="">Seleccionar</option>{menu.data.deliveryZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name} · {formatMoney(zone.deliveryFeeCents, restaurant.currencyCode, restaurant.locale)}</option>)}</select>{form.formState.errors.deliveryZoneId ? <small>{form.formState.errors.deliveryZoneId.message}</small> : null}</label><label className="field sm:col-span-2"><span>Dirección</span><input autoComplete="street-address" {...form.register('address')} />{form.formState.errors.address ? <small>{form.formState.errors.address.message}</small> : null}</label><label className="field"><span>Ciudad</span><input autoComplete="address-level2" {...form.register('city')} />{form.formState.errors.city ? <small>{form.formState.errors.city.message}</small> : null}</label><label className="field"><span>Barrio</span><input {...form.register('neighborhood')} /></label><label className="field"><span>Piso</span><input {...form.register('floor')} /></label><label className="field"><span>Departamento</span><input {...form.register('apartment')} /></label><label className="field sm:col-span-2"><span>Referencia</span><input {...form.register('reference')} /></label></div> : null}</section>
        {channel === 'store' ? <section className="form-card"><h2 className="form-card-title">¿Cómo querés comprar?</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{restaurant.storeCheckoutWhatsappEnabled !== false ? <label className={`choice-card ${checkoutMode === 'whatsapp' ? 'choice-card-selected' : ''}`}><input type="radio" name="checkoutMode" value="whatsapp" checked={checkoutMode === 'whatsapp'} onChange={() => setCheckoutMode('whatsapp')} /><span><strong>Pedir por WhatsApp</strong><small>Coordiná el pago con el comercio</small></span></label> : null}{restaurant.storeCheckoutOnlineEnabled ? <label className={`choice-card ${checkoutMode === 'online' ? 'choice-card-selected' : ''}`}><input type="radio" name="checkoutMode" value="online" checked={checkoutMode === 'online'} onChange={() => setCheckoutMode('online')} /><span><strong>Pagar online</strong><small>Pago seguro en Mercado Pago</small></span></label> : null}</div></section> : null}
        {checkoutMode === 'whatsapp' ? <section className="form-card"><h2 className="form-card-title">Medio de pago</h2><div className="mt-4 space-y-2">{menu.data.paymentMethods.filter(method => method.provider !== 'mercadopago').map((method) => <label key={method.id} className={`choice-card ${paymentMethodId === method.id ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value={method.id} {...form.register('paymentMethodId')} /><ShoppingBag aria-hidden /><span><strong>{method.name}</strong><small>{method.description}{method.adjustmentType !== 'none' ? ` · ${method.adjustmentBps / 100}% ${method.adjustmentType === 'discount' ? 'de descuento' : 'de recargo'}` : ''}</small></span>{paymentMethodId === method.id ? <Check className="ml-auto" aria-hidden /> : null}</label>)}</div>{form.formState.errors.paymentMethodId ? <p className="form-error">{form.formState.errors.paymentMethodId.message}</p> : null}</section> : <section className="form-card"><h2 className="form-card-title">Mercado Pago</h2><p className="text-sm text-stone-600">En el siguiente paso verás el total y podrás abrir Mercado Pago para pagar. Tus productos quedan reservados durante 30 minutos. Después del pago, el comercio te contactará por WhatsApp para coordinar la entrega o el retiro.</p></section>}
        <section className="form-card"><label className="field"><span>Observaciones generales (opcional)</span><textarea placeholder="¿Hay algo más que el comercio deba saber?" rows={3} maxLength={500} {...form.register('notes')} /></label><label className="absolute -left-[10000px]" aria-hidden="true"><span>Sitio web</span><input tabIndex={-1} autoComplete="off" {...form.register('website')} /></label></section></fieldset>{env.isTurnstileConfigured?<section className="form-card"><h2 className="form-card-title">Control anti-spam</h2><div className="mt-4"><TurnstileWidget key={turnstileReset} siteKey={env.turnstileSiteKey} onTokenChange={setTurnstileToken}/></div></section>:null}</div>
        <aside className="h-fit rounded-3xl bg-stone-950 p-6 text-white lg:sticky lg:top-6"><h2 className="font-display text-xl font-bold">Total estimado</h2><dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between text-stone-300"><dt>Subtotal</dt><dd>{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</dd></div>{adjustment !== 0 ? <div className="flex justify-between text-stone-300"><dt>{adjustment < 0 ? 'Descuento' : 'Recargo'}</dt><dd>{formatMoney(adjustment, restaurant.currencyCode, restaurant.locale)}</dd></div> : null}<div className="flex justify-between text-stone-300"><dt>{fulfillmentType === 'pickup' ? 'Retiro en el local' : 'Envío'}</dt><dd>{fulfillmentType === 'delivery' && !selectedZone ? 'Elegí tu zona' : deliveryFee === 0 ? 'Sin cargo' : formatMoney(deliveryFee, restaurant.currencyCode, restaurant.locale)}</dd></div><div className="flex justify-between border-t border-stone-700 pt-4 text-lg font-bold"><dt>Total</dt><dd>{formatMoney(estimatedTotal, restaurant.currencyCode, restaurant.locale)}</dd></div></dl><p className="mt-4 text-xs leading-5 text-stone-300">Confirmaremos el precio y la disponibilidad antes de continuar. Si algo cambió, te lo avisaremos.</p>{serverError ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-xs text-red-100" role="alert">{serverError}</p> : null}<button className="button-primary mt-5 w-full" disabled={sending || (pending ? (env.isTurnstileConfigured && !turnstileToken) || (!locked && cart.lines.length === 0) : !eligible)} type="submit">{sending ? 'Consultando pedido…' : pending ? 'Recuperar mismo pedido' : checkoutMode === 'online' ? 'Continuar al pago' : 'Generar pedido'}</button><p className="mt-3 text-center text-xs text-amber-300">{checkoutMode === 'online' ? 'El pago se confirma al recibir la aprobación de Mercado Pago.' : 'El pedido queda confirmado cuando el comercio lo acepte.'}</p></aside></form></div></main>
  )
}
