import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, PackageOpen, Store } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
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
  const range = useMemo(() => restaurantQuery.data ? dayRangeInTimeZone(now, restaurantQuery.data.timezone) : null, [now, restaurantQuery.data])
  const query = useQuery({
    queryKey: ['dashboard-orders', selected?.id, range?.from, range?.to], enabled: Boolean(selected && range),
    queryFn: async () => {
      if (!selected || !range) throw new Error('Falta seleccionar un comercio.')
      const { data, error } = await supabase.rpc('get_order_metrics', { p_restaurant_id: selected.id, p_from: range.from, p_to: range.to })
      if (error) throw new Error('No se pudieron cargar las métricas.')
      return orderMetricsSchema.parse(data)
    },
  })
  useEffect(() => {
    if (!selected) return
    const restaurantId = selected.id
    const channel = supabase.channel(`dashboard-orders:${restaurantId}`).on('postgres_changes',
      { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` },
      () => { void queryClient.invalidateQueries({ queryKey: ['dashboard-orders', restaurantId] }); void queryClient.invalidateQueries({ queryKey: ['orders', restaurantId] }) },
    ).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [queryClient, selected])

  if (!selected || query.isLoading || restaurantQuery.isLoading) return <LoadingScreen />
  if (query.error || restaurantQuery.error || !restaurantQuery.data || !query.data) return <ErrorPanel>{query.error?.message ?? restaurantQuery.error?.message ?? 'No se pudo cargar el comercio.'}</ErrorPanel>
  const restaurant = restaurantQuery.data
  const metrics = query.data
  const isAdmin = selected.role !== 'order_manager'
  const money = (amount: number) => formatMoney(amount, restaurant.currency_code, restaurant.locale)
  const metricsSummary = [
    { label: 'Pedidos recibidos', value: metrics.generated, detail: 'Creados hoy' },
    { label: 'Entregas vigentes', value: metrics.completed, detail: 'De los pedidos de hoy' },
    { label: 'Importe aceptado o entregado', value: money(metrics.acceptedAmountCents), detail: 'Pedidos vigentes de hoy' },
    { label: 'Importe entregado', value: money(metrics.completedAmountCents), detail: 'Pedidos vigentes de hoy' },
  ]
  const secondaryMetrics = [
    ['WhatsApp abierto', metrics.whatsappOpened], ['Aceptados alguna vez', metrics.accepted],
    ['Cancelados', metrics.cancelled], ['Expirados', metrics.expired],
    ['Entregas corregidas', metrics.corrected], ['Devoluciones completas', metrics.returned],
  ] as const
  return <>
    <PageHeader eyebrow={selected.name} title="Resumen" description="Una mirada a la actividad de tu comercio hoy." actions={<Link className="button-primary" to="/admin/pedidos">Ver pedidos<ArrowUpRight className="h-4 w-4" aria-hidden /></Link>} />
    <section aria-label="Resumen del día" className="surface-card overflow-hidden">
      <div className="grid grid-cols-2 xl:grid-cols-4">
        {metricsSummary.map((metric, index) => <article key={metric.label} className={`min-w-0 p-4 sm:p-6 ${index > 0 ? 'xl:border-l xl:border-stone-200' : ''} ${index % 2 ? 'border-l border-stone-200' : ''} ${index > 1 ? 'border-t border-stone-200 xl:border-t-0' : ''}`}>
          <h2 className="min-h-10 text-sm font-medium text-stone-500 xl:min-h-0">{metric.label}</h2>
          <p className="mt-3 break-words text-2xl font-semibold tracking-tight text-stone-900 tabular-nums sm:text-[1.75rem]">{metric.value}</p>
          <p className="mt-2 text-xs text-stone-500">{metric.detail}</p>
        </article>)}
      </div>
      <p className="border-t border-stone-100 px-5 py-3 text-xs leading-5 text-stone-500 sm:px-6">Según el horario local del comercio. Los importes corresponden a pedidos, no confirman cobros ni reintegros.</p>
    </section>

    <section aria-label="Accesos del comercio" className="my-6 grid gap-3 sm:grid-cols-2">
      <Link to={isAdmin ? '/admin/catalogo/productos' : '/admin/stock'} className="surface-card group flex items-center gap-4 p-5 transition-colors hover:border-stone-300">
        <PackageOpen className="h-5 w-5 shrink-0 text-stone-400" aria-hidden /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{isAdmin ? 'Tu catálogo' : 'Stock disponible'}</h2><p className="mt-1 text-sm text-stone-500">{isAdmin ? 'Productos, precios y cantidades.' : 'Consultá existencias y reservas.'}</p></div><ArrowUpRight className="h-4 w-4 shrink-0 text-stone-400 group-hover:text-orange-700" aria-hidden />
      </Link>
      {isAdmin ? <Link to="/admin/tienda" className="surface-card group flex items-center gap-4 p-5 transition-colors hover:border-stone-300"><Store className="h-5 w-5 shrink-0 text-stone-400" aria-hidden /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Tu tienda online</h2><p className="mt-1 text-sm text-stone-500">{restaurant.store_enabled ? 'Publicada y lista para compartir.' : 'Configurá cómo recibir compras y publicala.'}</p></div><ArrowUpRight className="h-4 w-4 shrink-0 text-stone-400 group-hover:text-orange-700" aria-hidden /></Link> : null}
    </section>

    <PublicChannelsCard canConfigure={isAdmin} slug={selected.slug} menuEnabled={restaurant.public_menu_enabled} storeEnabled={restaurant.store_enabled} />

    <details className="admin-disclosure mt-6">
      <summary>Ver detalle del día</summary>
      <div className="grid gap-7 pt-5 md:grid-cols-2">
        <section><h2 className="text-sm font-semibold text-stone-900">Estado de los pedidos</h2><p className="mt-1 text-xs text-stone-500">Pedidos creados hoy; cada indicador mantiene su criterio.</p><dl className="mt-4 divide-y divide-stone-100 text-sm">{secondaryMetrics.map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-2.5"><dt className="text-stone-600">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl></section>
        <section><h2 className="text-sm font-semibold text-stone-900">Entregas y devoluciones</h2><p className="mt-1 text-xs text-stone-500">Operaciones de hoy, incluso de pedidos anteriores.</p><dl className="mt-4 divide-y divide-stone-100 text-sm">{[
          ['Casos comerciales entregados vigentes', metrics.validDeliveredCommercialCases], ['Entregas físicas con inventario', metrics.physicalDispatches],
          ['Unidades recibidas por devolución', BigInt(metrics.receivedReturnUnits).toLocaleString('es-AR')], ['Unidades devueltas repuestas como vendibles', BigInt(metrics.sellableRestockedReturnUnits).toLocaleString('es-AR')],
        ].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-2.5"><dt className="text-stone-600">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl></section>
        <section><h2 className="text-sm font-semibold text-stone-900">Modalidad de entrega</h2><p className="mt-1 text-xs text-stone-500">Pedidos creados hoy.</p><dl className="mt-4 divide-y divide-stone-100 text-sm"><div className="flex justify-between py-2.5"><dt className="text-stone-600">Envío</dt><dd>{metrics.byFulfillment.delivery ?? 0}</dd></div><div className="flex justify-between py-2.5"><dt className="text-stone-600">Retiro</dt><dd>{metrics.byFulfillment.pickup ?? 0}</dd></div></dl></section>
        <section><h2 className="text-sm font-semibold text-stone-900">Medios de pago elegidos</h2><p className="mt-1 text-xs text-stone-500">Importes de pedidos vigentes aceptados o entregados; no confirma pagos.</p>{metrics.byPaymentMethod.length ? <dl className="mt-4 divide-y divide-stone-100 text-sm">{metrics.byPaymentMethod.map(method => <div className="flex items-center justify-between gap-4 py-2.5" key={method.name}><dt className="text-stone-600">{method.name}<span className="mt-0.5 block text-xs text-stone-400">{method.count} pedidos</span></dt><dd className="font-medium tabular-nums">{money(method.amountCents)}</dd></div>)}</dl> : <p className="mt-4 text-sm text-stone-500">Todavía no hay pedidos aceptados o entregados.</p>}</section>
      </div>
    </details>
  </>
}
