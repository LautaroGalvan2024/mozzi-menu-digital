import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft, Bike, Check, ShoppingBag, Store } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { checkoutCartFingerprint, clearCheckoutAttempt, getCheckoutAttemptKey } from '../../lib/checkout-attempt'
import { env } from '../../lib/env'
import { formatMoney } from '../../lib/money'
import { estimateAdjustment } from '../../lib/orders'
import { supabase } from '../../lib/supabase/client'
import { checkoutSchema, generatedOrderSchema, type CheckoutValues } from '../../lib/validation/schemas'
import type { GeneratedOrder } from '../../types/domain'
import { useCart } from '../cart/CartProvider'
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
  const { activateRestaurant } = cart
  const navigate = useNavigate()
  const mountedAttempt = useRef<{ fingerprint: string; key: string } | null>(null)
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
    if (!menu.data) return
    const restaurant = menu.data.restaurant
    if (formRestaurantId.current !== restaurant.id) {
      formRestaurantId.current = restaurant.id
      mountedAttempt.current = null
      formStartedAt.current = new Date().toISOString()
      setServerError(null)
      setTurnstileToken(null)
      setTurnstileReset((value) => value + 1)
      form.reset({
        ...emptyCheckoutValues,
        fulfillmentType: restaurant.pickupEnabled ? 'pickup' : 'delivery',
        paymentMethodId: menu.data.paymentMethods[0]?.id ?? '',
      })
      return
    }

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
  }, [form, menu.data])

  const selectedPayment = menu.data?.paymentMethods.find((method) => method.id === paymentMethodId)
  const selectedZone = menu.data?.deliveryZones.find((zone) => zone.id === deliveryZoneId)
  const deliveryFee = fulfillmentType === 'delivery' && selectedZone ? (selectedZone.freeShippingFromCents !== null && cart.subtotalCents >= selectedZone.freeShippingFromCents ? 0 : selectedZone.deliveryFeeCents) : 0
  const adjustment = selectedPayment ? estimateAdjustment(selectedPayment, cart.subtotalCents, deliveryFee) : 0
  const estimatedTotal = Math.max(0, cart.subtotalCents + deliveryFee + adjustment)
  const eligible = useMemo(() => {
    if (!menu.data) return false
    const zoneMinimum = fulfillmentType === 'delivery' ? selectedZone?.minimumOrderCents ?? 0 : 0
    const minimum = Math.max(menu.data.restaurant.minimumOrderCents, zoneMinimum)
    const antiSpamReady = !env.isTurnstileConfigured || Boolean(turnstileToken)
    const fulfillmentReady = fulfillmentType === 'pickup'
      ? menu.data.restaurant.pickupEnabled
      : menu.data.restaurant.deliveryEnabled && Boolean(selectedZone)
    return menu.data.restaurant.isOpen && Boolean(selectedPayment) && fulfillmentReady && cart.subtotalCents >= minimum && cart.itemCount <= 100 && cart.lines.length <= 25 && antiSpamReady
  }, [cart.itemCount, cart.lines.length, cart.subtotalCents, fulfillmentType, menu.data, selectedPayment, selectedZone, turnstileToken])

  if (menu.isLoading) return <LoadingScreen label="Revalidando el menú…" />
  if (!menu.data) return <main className="page-shell py-16"><ErrorPanel>No pudimos cargar los datos necesarios para confirmar.</ErrorPanel></main>
  if (cart.restaurantSlug !== menu.data.restaurant.slug) return <LoadingScreen label="Recuperando tu carrito…" />
  if (cart.lines.length === 0) return <Navigate to={`/r/${restaurantSlug}/carrito`} replace />
  const restaurant = menu.data.restaurant

  const submit = form.handleSubmit(async (values) => {
    setServerError(null)
    if (!eligible) { setServerError('El comercio está cerrado o el pedido no alcanza el mínimo.'); return }
    const fingerprint = checkoutCartFingerprint(cart.lines)
    if (!mountedAttempt.current || mountedAttempt.current.fingerprint !== fingerprint) {
      mountedAttempt.current = {
        fingerprint,
        key: getCheckoutAttemptKey(restaurant.slug, fingerprint),
      }
    }
    const body = {
      restaurantSlug: restaurant.slug,
      idempotencyKey: mountedAttempt.current.key,
      customer: { name: values.customerName, phone: values.customerPhone },
      fulfillment: {
        type: values.fulfillmentType,
        ...(values.fulfillmentType === 'delivery' ? { deliveryZoneId: values.deliveryZoneId, address: values.address, city: values.city, neighborhood: values.neighborhood, floor: values.floor, apartment: values.apartment, reference: values.reference } : {}),
      },
      paymentMethodId: values.paymentMethodId,
      notes: values.notes,
      items: cart.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, notes: line.notes, optionIds: line.selectedOptions.map((option) => option.id) })),
      antiSpam: { honeypot: values.website, formStartedAt: formStartedAt.current, ...(turnstileToken ? { turnstileToken } : {}) },
    }
    const { data, error } = await supabase.functions.invoke('create-order', { body })
    if (error) {
      let message = 'No pudimos crear el pedido. Revisá los datos y volvé a intentar.'
      const context = (error as { context?: unknown }).context
      if (context instanceof Response) {
        try {
          const parsedError = zodErrorResponse.safeParse(await context.clone().json())
          if (parsedError.success) {
            message = publicOrderErrors[parsedError.data.error.code] ?? message
          }
        } catch {
          // Keep a stable public message for non-JSON network failures.
        }
      }
      formStartedAt.current = new Date().toISOString()
      setTurnstileToken(null)
      setTurnstileReset((value) => value + 1)
      setServerError(message)
      return
    }
    const parsed = generatedOrderSchema.safeParse(data)
    if (!parsed.success) { setServerError('El servidor devolvió una respuesta inesperada. Volvé a intentar: la misma clave evita duplicar el pedido.'); return }
    const generated: GeneratedOrder = parsed.data
    clearCheckoutAttempt(restaurant.slug)
    navigate(`/r/${restaurant.slug}/pedido-generado`, {
      state: generated,
      replace: true,
    })
  })

  return (
    <main className="min-h-screen bg-stone-100 py-6 sm:py-10"><div className="page-shell max-w-5xl"><Link to={`/r/${restaurant.slug}/carrito`} className="inline-flex items-center gap-2 text-sm font-semibold text-stone-600"><ArrowLeft className="h-4 w-4" aria-hidden />Volver al carrito</Link><div className="mt-5"><h1 className="font-display text-4xl font-bold">Finalizar pedido</h1><p className="mt-2 text-stone-600">El comercio debe aceptar el pedido desde el enlace seguro que recibirá por WhatsApp.</p></div>
      <form className="mt-8 grid gap-6 lg:grid-cols-[1fr_350px]" onSubmit={submit} noValidate><div className="space-y-5"><section className="form-card"><h2 className="form-card-title">Tus datos</h2><div className="grid gap-4 sm:grid-cols-2"><label className="field"><span>Nombre y apellido</span><input autoComplete="name" {...form.register('customerName')} />{form.formState.errors.customerName ? <small>{form.formState.errors.customerName.message}</small> : null}</label><label className="field"><span>Teléfono</span><input type="tel" autoComplete="tel" {...form.register('customerPhone')} />{form.formState.errors.customerPhone ? <small>{form.formState.errors.customerPhone.message}</small> : null}</label></div></section>
        <section className="form-card"><h2 className="form-card-title">¿Cómo lo recibís?</h2><div className="grid gap-3 sm:grid-cols-2">{restaurant.pickupEnabled ? <label className={`choice-card ${fulfillmentType === 'pickup' ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value="pickup" {...form.register('fulfillmentType')} /><Store aria-hidden /><span><strong>Retiro</strong><small>{restaurant.address}</small></span>{fulfillmentType === 'pickup' ? <Check className="ml-auto" aria-hidden /> : null}</label> : null}{restaurant.deliveryEnabled ? <label className={`choice-card ${fulfillmentType === 'delivery' ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value="delivery" {...form.register('fulfillmentType')} /><Bike aria-hidden /><span><strong>Envío</strong><small>Elegí tu zona</small></span>{fulfillmentType === 'delivery' ? <Check className="ml-auto" aria-hidden /> : null}</label> : null}</div>
        {fulfillmentType === 'delivery' ? <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="field sm:col-span-2"><span>Zona</span><select {...form.register('deliveryZoneId')}><option value="">Seleccionar</option>{menu.data.deliveryZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name} · {formatMoney(zone.deliveryFeeCents, restaurant.currencyCode, restaurant.locale)}</option>)}</select>{form.formState.errors.deliveryZoneId ? <small>{form.formState.errors.deliveryZoneId.message}</small> : null}</label><label className="field sm:col-span-2"><span>Dirección</span><input autoComplete="street-address" {...form.register('address')} />{form.formState.errors.address ? <small>{form.formState.errors.address.message}</small> : null}</label><label className="field"><span>Ciudad</span><input autoComplete="address-level2" {...form.register('city')} />{form.formState.errors.city ? <small>{form.formState.errors.city.message}</small> : null}</label><label className="field"><span>Barrio</span><input {...form.register('neighborhood')} /></label><label className="field"><span>Piso</span><input {...form.register('floor')} /></label><label className="field"><span>Departamento</span><input {...form.register('apartment')} /></label><label className="field sm:col-span-2"><span>Referencia</span><input {...form.register('reference')} /></label></div> : null}</section>
        <section className="form-card"><h2 className="form-card-title">Medio de pago</h2><div className="space-y-2">{menu.data.paymentMethods.map((method) => <label key={method.id} className={`choice-card ${paymentMethodId === method.id ? 'choice-card-selected' : ''}`}><input className="sr-only" type="radio" value={method.id} {...form.register('paymentMethodId')} /><ShoppingBag aria-hidden /><span><strong>{method.name}</strong><small>{method.description}{method.adjustmentType !== 'none' ? ` · ${method.adjustmentBps / 100}% ${method.adjustmentType === 'discount' ? 'de descuento' : 'de recargo'}` : ''}</small></span>{paymentMethodId === method.id ? <Check className="ml-auto" aria-hidden /> : null}</label>)}</div>{form.formState.errors.paymentMethodId ? <p className="form-error">{form.formState.errors.paymentMethodId.message}</p> : null}</section>
        <section className="form-card"><label className="field"><span>Observaciones generales</span><textarea rows={3} maxLength={500} {...form.register('notes')} /></label><label className="absolute -left-[10000px]" aria-hidden="true"><span>Sitio web</span><input tabIndex={-1} autoComplete="off" {...form.register('website')} /></label></section>{env.isTurnstileConfigured?<section className="form-card"><h2 className="form-card-title">Control anti-spam</h2><div className="mt-4"><TurnstileWidget key={turnstileReset} siteKey={env.turnstileSiteKey} onTokenChange={setTurnstileToken}/></div></section>:null}</div>
        <aside className="h-fit rounded-3xl bg-stone-950 p-6 text-white lg:sticky lg:top-6"><h2 className="font-display text-xl font-bold">Total estimado</h2><dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between text-stone-300"><dt>Subtotal</dt><dd>{formatMoney(cart.subtotalCents, restaurant.currencyCode, restaurant.locale)}</dd></div>{adjustment !== 0 ? <div className="flex justify-between text-stone-300"><dt>{adjustment < 0 ? 'Descuento' : 'Recargo'}</dt><dd>{formatMoney(adjustment, restaurant.currencyCode, restaurant.locale)}</dd></div> : null}<div className="flex justify-between text-stone-300"><dt>Envío</dt><dd>{deliveryFee === 0 ? 'Sin cargo' : formatMoney(deliveryFee, restaurant.currencyCode, restaurant.locale)}</dd></div><div className="flex justify-between border-t border-stone-700 pt-4 text-lg font-bold"><dt>Total</dt><dd>{formatMoney(estimatedTotal, restaurant.currencyCode, restaurant.locale)}</dd></div></dl><p className="mt-4 text-xs leading-5 text-stone-400">El servidor recalcula precios, disponibilidad y horario antes de crear el pedido.</p>{serverError ? <p className="mt-4 rounded-xl bg-red-950 p-3 text-xs text-red-100" role="alert">{serverError}</p> : null}<button className="button-primary mt-5 w-full" disabled={form.formState.isSubmitting || !eligible} type="submit">{form.formState.isSubmitting ? 'Creando pedido…' : 'Generar pedido'}</button><p className="mt-3 text-center text-xs text-amber-300">El pedido queda confirmado cuando el comercio lo acepte.</p></aside></form></div></main>
  )
}
