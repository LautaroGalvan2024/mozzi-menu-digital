import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ClipboardList,
  Clock3,
  Copy,
  ExternalLink,
  MessageCircle,
  ShoppingBag,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { MetricCard } from '../../components/MetricCard'
import { PageHeader } from '../../components/PageHeader'
import { SectionCard } from '../../components/SectionCard'
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
    ['Creados', metrics.generated, ClipboardList, 'amber'],
    ['WhatsApp abierto', metrics.whatsappOpened, MessageCircle, 'orange'],
    ['Tomados', metrics.accepted, ShoppingBag, 'blue'],
    ['Completados', metrics.completed, CheckCircle2, 'emerald'],
    ['Cancelados', metrics.cancelled, XCircle, 'red'],
    ['Expirados', metrics.expired, Clock3, 'orange'],
  ] as const
  const fulfillment = [
    ['Envío', metrics.byFulfillment.delivery ?? 0],
    ['Retiro', metrics.byFulfillment.pickup ?? 0],
  ] as const

  return (
    <>
      <PageHeader
        eyebrow="Hoy"
        title={`Hola, ${selected.name}`}
        description="Las métricas usan el día local del restaurante. Los pedidos generados no se cuentan como ventas confirmadas."
        actions={<Link className="button-primary" to="/admin/pedidos">Ver pedidos</Link>}
      />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.5fr)]">
        <article className="flex min-h-full flex-col justify-between overflow-hidden rounded-2xl bg-stone-950 p-6 text-white shadow-lg shadow-stone-950/10 sm:p-7">
          <div>
            <p className="text-sm font-medium text-stone-400">Importe de pedidos tomados</p>
            <p className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
              {formatMoney(metrics.acceptedAmountCents, restaurant.currency_code, restaurant.locale)}
            </p>
          </div>
          <div className="mt-8 rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs font-semibold uppercase tracking-[.12em] text-stone-400">Importe completado</p>
            <p className="mt-1.5 font-display text-2xl font-bold tracking-tight">
              {formatMoney(metrics.completedAmountCents, restaurant.currency_code, restaurant.locale)}
            </p>
          </div>
        </article>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stats.map(([label, value, Icon, tone]) => (
            <MetricCard label={label} value={value} icon={Icon} tone={tone} key={label} />
          ))}
        </div>
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-2">
        <SectionCard title="Modalidad" description="Distribución de los pedidos creados hoy.">
          <dl className="grid grid-cols-2 divide-x divide-stone-200 rounded-xl border border-stone-200 bg-stone-50">
            {fulfillment.map(([label, value]) => (
              <div className="p-4" key={label}>
                <dt className="text-sm font-medium text-stone-500">{label}</dt>
                <dd className="mt-1 font-display text-3xl font-bold tracking-tight text-stone-950">{value}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>

        <SectionCard title="Medios de pago" description="Cantidad e importe de los pedidos de hoy.">
          {metrics.byPaymentMethod.length ? (
            <div className="divide-y divide-stone-100">
              {metrics.byPaymentMethod.map((method) => (
                <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0" key={method.name}>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm text-stone-900">{method.name}</strong>
                    <p className="mt-0.5 text-xs text-stone-500">{method.count} pedidos</p>
                  </div>
                  <strong className="shrink-0 text-sm tabular-nums text-stone-950">
                    {formatMoney(method.amountCents, restaurant.currency_code, restaurant.locale)}
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-stone-500">Todavía no hay pedidos hoy.</p>
          )}
        </SectionCard>
      </section>

      <SectionCard className="mt-4" title="Tu menú público" description="Compartilo con tus clientes o revisalo en una nueva pestaña.">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 truncate rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-600" title={publicUrl}>
            {publicUrl}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              className="button-secondary"
              onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true))}
            >
              <Copy className="h-4 w-4" aria-hidden />
              {copied ? 'Copiado' : 'Copiar link'}
            </button>
            <a className="button-secondary" target="_blank" rel="noreferrer" href={publicUrl}>
              <ExternalLink className="h-4 w-4" aria-hidden />
              Abrir menú
            </a>
          </div>
        </div>
      </SectionCard>
    </>
  )
}
