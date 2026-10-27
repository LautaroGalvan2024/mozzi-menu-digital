import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ClipboardList,
  Clock3,
  MessageCircle,
  ShoppingBag,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { MetricCard } from '../../components/MetricCard'
import { PageHeader } from '../../components/PageHeader'
import { SectionCard } from '../../components/SectionCard'
import { formatMoney } from '../../lib/money'
import { supabase } from '../../lib/supabase/client'
import { dayRangeInTimeZone } from '../../lib/timezone'
import { useRestaurantScope } from './RestaurantScope'
import { useRestaurant } from './useRestaurant'
import { orderMetricsSchema } from '../orders/orderMetrics'
import { PublicChannelsCard } from './PublicChannelsCard'

export function AdminDashboardPage() {
  const scope = useRestaurantScope()
  const selected = scope.selected
  const queryClient = useQueryClient()
  const restaurantQuery = useRestaurant(selected?.id)
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
      return orderMetricsSchema.parse(data)
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
  const stats = [
    ['Creados', metrics.generated, ClipboardList, 'amber'],
    ['WhatsApp abierto', metrics.whatsappOpened, MessageCircle, 'orange'],
    ['Aceptados alguna vez', metrics.accepted, ShoppingBag, 'blue'],
    ['Entregas vigentes', metrics.completed, CheckCircle2, 'emerald'],
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
        description="Pedidos creados hoy, según el día local del comercio y su estado actual. Los importes vigentes excluyen entregas corregidas o devueltas; no representan cobros ni reintegros."
        actions={<Link className="button-primary" to="/admin/pedidos">Ver pedidos</Link>}
      />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.5fr)]">
        <article className="flex min-h-full flex-col justify-between overflow-hidden rounded-2xl bg-stone-950 p-6 text-white shadow-lg shadow-stone-950/10 sm:p-7">
          <div>
            <p className="text-sm font-medium text-stone-400">Importe vigente aceptado o entregado</p>
            <p className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
              {formatMoney(metrics.acceptedAmountCents, restaurant.currency_code, restaurant.locale)}
            </p>
          </div>
          <div className="mt-8 rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs font-semibold uppercase tracking-[.12em] text-stone-400">Importe de entregas vigentes</p>
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
        <SectionCard title="Correcciones y devoluciones" description="Estado actual de los pedidos creados hoy; el original se conserva en el historial.">
          <dl className="space-y-3 text-sm"><div className="flex justify-between"><dt>Entregas corregidas</dt><dd>{metrics.corrected}</dd></div><div className="flex justify-between"><dt>Devoluciones completas</dt><dd>{metrics.returned}</dd></div></dl>
        </SectionCard>
        <SectionCard title="Operaciones realizadas hoy" description="Según la fecha de entrega o movimiento, incluidos pedidos creados antes de hoy. Los reemplazos pertenecen al mismo caso comercial.">
          <dl className="space-y-3 text-sm"><div className="flex justify-between"><dt>Casos comerciales entregados vigentes</dt><dd>{metrics.validDeliveredCommercialCases}</dd></div><div className="flex justify-between"><dt>Entregas físicas con inventario</dt><dd>{metrics.physicalDispatches}</dd></div><div className="flex justify-between"><dt>Unidades recibidas por devolución</dt><dd>{BigInt(metrics.receivedReturnUnits).toLocaleString('es-AR')}</dd></div><div className="flex justify-between"><dt>Unidades devueltas repuestas como vendibles</dt><dd>{BigInt(metrics.sellableRestockedReturnUnits).toLocaleString('es-AR')}</dd></div></dl>
        </SectionCard>
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

        <SectionCard title="Medios de pago" description="Pedidos creados hoy, aceptados o entregados y vigentes. Excluye correcciones y devoluciones; no confirma pagos.">
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

      <div className="mt-4"><PublicChannelsCard canConfigure={selected.role !== 'order_manager'} slug={selected.slug} menuEnabled={restaurant.public_menu_enabled} storeEnabled={restaurant.store_enabled} /></div>
    </>
  )
}
