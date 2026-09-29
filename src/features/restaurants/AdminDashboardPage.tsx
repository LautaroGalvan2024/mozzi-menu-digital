import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ClipboardList, Copy, ExternalLink, ShoppingBag, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { env } from '../../lib/env'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { dayRangeInTimeZone } from '../../lib/timezone'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'

const count = z.number().int().nonnegative()
const money = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number)
const metricsSchema = z.object({
  generated: count,
  whatsappOpened: count,
  accepted: count,
  completed: count,
  cancelled: count,
  expired: count,
  acceptedAmountCents: money,
  completedAmountCents: money,
  byFulfillment: z.record(count),
  byPaymentMethod: z.array(z.object({ name: z.string(), count, amountCents: money })),
})

export function AdminDashboardPage() {
  const scope = useRestaurantScope()
  const selected = scope.selected
  const queryClient = useQueryClient()
  const restaurantQuery = useRestaurant(selected?.id)
  const [copied, setCopied] = useState(false)
  const [now] = useState(() => new Date())
  const range = useMemo(
    () => restaurantQuery.data ? dayRangeInTimeZone(now, restaurantQuery.data.timezone) : null,
    [now, restaurantQuery.data],
  )
  const query = useQuery({
    queryKey: ['dashboard-orders', selected?.id, range?.from, range?.to],
    enabled: Boolean(selected && range),
    queryFn: async () => {
      if (!selected || !range) throw new Error('Falta seleccionar un restaurante.')
      const { data, error } = await supabase.rpc('get_order_metrics', {
        p_restaurant_id: selected.id,
        p_from: range.from,
        p_to: range.to,
      })
      if (error) throw new Error('No se pudieron cargar las métricas.')
      return metricsSchema.parse(data)
    },
  })

  useEffect(() => {
    if (!selected) return
    const restaurantId = selected.id
    const channel = supabase
      .channel(`dashboard-orders:${restaurantId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['dashboard-orders', restaurantId] })
          void queryClient.invalidateQueries({ queryKey: ['orders', restaurantId] })
        },
      )
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [queryClient, selected])

  if (!selected || query.isLoading || restaurantQuery.isLoading) return <LoadingScreen />
  if (query.error || restaurantQuery.error || !restaurantQuery.data || !query.data) {
    return <ErrorPanel>{query.error?.message ?? restaurantQuery.error?.message ?? 'No se pudo cargar el restaurante.'}</ErrorPanel>
  }

  const restaurant = restaurantQuery.data
  const metrics = query.data
  const publicUrl = `${env.appBaseUrl}/r/${selected.slug}`
  const stats = [
    ['Creados', metrics.generated, ClipboardList, 'text-amber-700 bg-amber-100'],
    ['Tomados', metrics.accepted, ShoppingBag, 'text-blue-700 bg-blue-100'],
    ['Completados', metrics.completed, CheckCircle2, 'text-emerald-700 bg-emerald-100'],
    ['Cancelados', metrics.cancelled, XCircle, 'text-red-700 bg-red-100'],
  ] as const
  const fulfillment = [
    ['Envío', metrics.byFulfillment.delivery ?? 0],
    ['Retiro', metrics.byFulfillment.pickup ?? 0],
  ] as const

  return <>
    <PageHeader eyebrow="Hoy" title={`Hola, ${selected.name}`} description="Las métricas usan el día local del restaurante. Los pedidos generados no se cuentan como ventas confirmadas." actions={<Link className="button-primary" to="/admin/pedidos">Ver pedidos</Link>} />
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{stats.map(([label,value,Icon,color]) => <article className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm" key={label}><span className={`grid h-11 w-11 place-items-center rounded-2xl ${color}`}><Icon className="h-5 w-5" aria-hidden /></span><p className="mt-5 text-sm text-stone-500">{label}</p><p className="font-display text-3xl font-bold">{value}</p></article>)}</section>
    <section className="mt-6 grid gap-4 md:grid-cols-2">
      <article className="rounded-3xl bg-stone-950 p-6 text-white"><p className="text-sm text-stone-400">Importe de pedidos tomados</p><p className="mt-2 font-display text-4xl font-bold">{formatMoney(metrics.acceptedAmountCents,restaurant.currency_code,restaurant.locale)}</p><p className="mt-5 text-sm text-stone-400">Importe completado</p><p className="mt-1 font-display text-2xl font-bold">{formatMoney(metrics.completedAmountCents,restaurant.currency_code,restaurant.locale)}</p></article>
      <article className="rounded-3xl border border-stone-200 bg-white p-6"><h2 className="font-display text-xl font-bold">Modalidad</h2><dl className="mt-4 space-y-3">{fulfillment.map(([label,value])=><div className="flex justify-between" key={label}><dt className="text-stone-600">{label}</dt><dd className="font-bold">{value}</dd></div>)}</dl><p className="mt-5 text-xs text-stone-500">WhatsApp abierto: {metrics.whatsappOpened} · Vencidos: {metrics.expired}</p></article>
    </section>
    <section className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <article className="rounded-3xl border border-stone-200 bg-white p-6"><h2 className="font-display text-xl font-bold">Medios de pago</h2>{metrics.byPaymentMethod.length?<div className="mt-4 space-y-3">{metrics.byPaymentMethod.map((method)=><div className="flex items-center justify-between gap-4 rounded-xl bg-stone-50 p-3" key={method.name}><div><strong>{method.name}</strong><p className="text-xs text-stone-500">{method.count} pedidos</p></div><strong>{formatMoney(method.amountCents,restaurant.currency_code,restaurant.locale)}</strong></div>)}</div>:<p className="mt-4 text-sm text-stone-500">Todavía no hay pedidos hoy.</p>}</article>
      <article className="rounded-3xl border border-stone-200 bg-white p-6"><h2 className="font-display text-xl font-bold">Tu menú público</h2><p className="mt-2 break-all text-sm text-stone-600">{publicUrl}</p><div className="mt-5 flex flex-wrap gap-2"><button className="button-secondary" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true))}><Copy className="h-4 w-4" aria-hidden />{copied ? 'Copiado' : 'Copiar link'}</button><a className="button-secondary" target="_blank" rel="noreferrer" href={publicUrl}><ExternalLink className="h-4 w-4" aria-hidden />Abrir menú</a></div></article>
    </section>
  </>
}
