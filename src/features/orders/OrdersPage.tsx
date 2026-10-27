import { AdminOrderStatus } from './CommerceOrderStatus'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { EmptyState, ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { FilterBar } from '../../components/FilterBar'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { orderSearchFilter } from '../../lib/orders'
import { supabase } from '../../lib/supabase/client'
import { dateInTimeZone, dateRangeForLocalDates } from '../../lib/timezone'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { adminOrderSchema, statusLabel, type AdminOrderRow } from './orderSchemas'
import { OrderWhatsAppAction } from './OrderWhatsAppAction'
import { orderCommercialReport } from './inventoryOrder'

const PAGE_SIZE = 25

export function orderDateRangeError(from: string, to: string) {
  if (!from || !to || from <= to) return null
  return 'La fecha Desde no puede ser posterior a la fecha Hasta.'
}

export function OrdersPage() {
  const scope = useRestaurantScope()
  const restaurant = useRestaurant(scope.selected?.id)
  const client = useQueryClient()
  const [page, setPage] = useState(0)
  const [status, setStatus] = useState<'' | AdminOrderRow['status']>('')
  const [fulfillment, setFulfillment] = useState<'' | AdminOrderRow['fulfillment_type']>('')
  const [search, setSearch] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [dates, setDates] = useState({ restaurantId: '', from: '', to: '' })
  const restaurantId = scope.selected?.id
  const restaurantTimeZone = restaurant.data?.timezone

  useEffect(() => {
    if (!restaurantId || !restaurantTimeZone) return
    const today = dateInTimeZone(new Date(), restaurantTimeZone)
    setDates({ restaurantId, from: today, to: today })
    setPage(0)
  }, [restaurantId, restaurantTimeZone])

  const datesReady = Boolean(
    scope.selected &&
      restaurant.data &&
      dates.restaurantId === scope.selected.id &&
      dates.from &&
      dates.to,
  )
  const dateError = datesReady ? orderDateRangeError(dates.from, dates.to) : null
  const query = useQuery({
    queryKey: [
      'orders',
      scope.selected?.id,
      restaurant.data?.timezone,
      page,
      status,
      fulfillment,
      search,
      dates.from,
      dates.to,
    ],
    enabled: datesReady && !dateError,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === scope.selected?.id ? keepPreviousData(previous) : undefined,
    queryFn: async () => {
      const range = dateRangeForLocalDates(
        dates.from,
        dates.to,
        restaurant.data?.timezone ?? 'UTC',
      )
      let request = supabase
        .from('orders')
        .select('*', { count: 'exact' })
        .eq('restaurant_id', scope.selected?.id ?? '')
        .gte('created_at', range.from)
        .lt('created_at', range.to)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
      if (status) request = request.eq('status', status)
      if (fulfillment) request = request.eq('fulfillment_type', fulfillment)
      const filter = orderSearchFilter(search)
      if (filter) request = request.ilike(filter.field, `%${filter.value}%`)
      const { data, error, count } = await request
      if (error) throw new Error('No se pudieron cargar los pedidos.')
      return { rows: z.array(adminOrderSchema).parse(data), count: count ?? 0 }
    },
  })

  useEffect(() => {
    if (!scope.selected) return
    const channel = supabase
      .channel(`orders:${scope.selected.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `restaurant_id=eq.${scope.selected.id}`,
        },
        () => {
          void client.invalidateQueries({ queryKey: ['orders', scope.selected?.id] })
          void client.invalidateQueries({ queryKey: ['dashboard-orders', scope.selected?.id] })
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [client, scope.selected])

  if (!scope.selected) return <ErrorPanel>Falta seleccionar un comercio.</ErrorPanel>
  if (restaurant.error || query.error) {
    return <ErrorPanel>{restaurant.error?.message ?? query.error?.message}</ErrorPanel>
  }
  if (restaurant.isLoading || query.isLoading || !datesReady) return <LoadingScreen />
  const rows = dateError ? [] : (query.data?.rows ?? [])
  const businessName = restaurant.data?.trade_name || restaurant.data?.name || scope.selected.name

  async function exportCsv() {
    if (!scope.selected || !restaurant.data || dateError) return
    setExporting(true)
    setExportError(null)
    try {
      const range = dateRangeForLocalDates(dates.from, dates.to, restaurant.data.timezone)
      const exported: AdminOrderRow[] = []
      const batchSize = 1000
      for (let offset = 0; ; offset += batchSize) {
        let request = supabase
          .from('orders')
          .select('*')
          .eq('restaurant_id', scope.selected.id)
          .gte('created_at', range.from)
          .lt('created_at', range.to)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + batchSize - 1)
        if (status) request = request.eq('status', status)
        if (fulfillment) request = request.eq('fulfillment_type', fulfillment)
        const filter = orderSearchFilter(search)
        if (filter) request = request.ilike(filter.field, `%${filter.value}%`)
        const { data, error: loadError } = await request
        if (loadError) throw loadError
        const batch = z.array(adminOrderSchema).parse(data)
        exported.push(...batch)
        if (batch.length < batchSize) break
      }
      const report = exported.map(orderCommercialReport)
      const columns = Object.keys(report[0] ?? {})
      const safe = (value: unknown) => {
        const text = String(value ?? '')
        const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text
        return `"${protectedText.replace(/"/g, '""')}"`
      }
      const csv = [
        columns.join(','),
        ...report.map((row) =>
          columns.map((column) => safe(row[column as keyof typeof row])).join(','),
        ),
      ].join('\r\n')
      const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `pedidos-${dates.from}-${dates.to}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setExportError('No se pudo exportar el historial completo con estos filtros.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Tiempo real"
        title="Pedidos"
        description="Consultá tus pedidos y contactá a cada cliente."
        actions={
          <button
            className="button-secondary"
            title="El CSV conserva los importes originales y separa los vigentes para no sumar dos veces un reemplazo."
            disabled={!rows.length || exporting || query.isFetching || Boolean(dateError)}
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" aria-hidden />
            {exporting ? 'Exportando…' : 'Exportar resultados'}
          </button>
        }
      />
      {exportError ? (
        <p className="form-error mb-4" role="alert">
          {exportError}
        </p>
      ) : null}
      <FilterBar className="mb-5 grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
        <label className="field min-w-0">
          <span>Buscar</span>
          <span className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <input
              className="!pl-9"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(0)
              }}
              placeholder="Cliente, teléfono o número"
            />
          </span>
        </label>
        <label className="field min-w-0">
          <span>Estado</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as '' | AdminOrderRow['status'])
              setPage(0)
            }}
          >
            <option value="">Todos</option>
            {Object.entries(statusLabel).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <details className="admin-disclosure md:col-span-2" open={Boolean(dateError) || undefined}>
          <summary className="flex flex-wrap items-center gap-x-3 gap-y-1"><span>Fechas y modalidad</span><span className="text-xs font-normal text-stone-500">{dates.from === dates.to ? dates.from.split('-').reverse().join('/') : `${dates.from.split('-').reverse().join('/')} — ${dates.to.split('-').reverse().join('/')}`}{fulfillment ? ` · ${fulfillment === 'delivery' ? 'Envío' : 'Retiro'}` : ''}</span></summary>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="field col-span-2 min-w-0 sm:col-span-1">
          <span>Modalidad</span>
          <select
            value={fulfillment}
            onChange={(event) => {
              setFulfillment(event.target.value as '' | AdminOrderRow['fulfillment_type'])
              setPage(0)
            }}
          >
            <option value="">Todas</option>
            <option value="delivery">Envío</option>
            <option value="pickup">Retiro</option>
          </select>
        </label>
        <label className="field min-w-0">
          <span>Desde</span>
          <input
            type="date"
            value={dates.from}
            onChange={(event) => {
              if (event.target.value) {
                setDates((value) => ({ ...value, from: event.target.value }))
              }
              setPage(0)
            }}
          />
        </label>
        <label className="field min-w-0">
          <span>Hasta</span>
          <input
            type="date"
            value={dates.to}
            onChange={(event) => {
              if (event.target.value) {
                setDates((value) => ({ ...value, to: event.target.value }))
              }
              setPage(0)
            }}
          />
        </label>
          </div>
        </details>
      </FilterBar>
      {query.isFetching ? <p className="mb-3 text-xs text-stone-500" role="status">Actualizando pedidos…</p> : null}
      {dateError ? (
        <p className="form-error mb-5" role="alert">{dateError}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No hay pedidos para estos filtros"
          description="Los pedidos nuevos aparecerán automáticamente."
        />
      ) : (
        <>
          <div className="admin-table-shell hidden overflow-hidden xl:block" aria-busy={query.isFetching}>
            <table className="data-table orders-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Estado</th>
                  <th>Modalidad</th>
                  <th className="text-right">Total</th>
                  <th>Creado</th>
                  <th><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="font-display font-bold text-stone-950">{row.display_number}</td>
                    <td><strong className="block text-stone-900">{row.customer_name}</strong><small className="text-stone-500">{row.customer_phone}</small></td>
                    <td><AdminOrderStatus order={row} />{row.replaces_order_id?<small className="mt-1 block text-stone-500">Pedido de reemplazo</small>:null}</td>
                    <td className="text-stone-600">{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}</td>
                    <td className="whitespace-nowrap text-right font-bold tabular-nums text-stone-950">{formatMoney(row.total_cents, row.currency_code)}</td>
                    <td className="whitespace-nowrap text-stone-500">{new Date(row.created_at).toLocaleString('es-AR')}</td>
                    <td><div className="flex items-center justify-end gap-1"><OrderWhatsAppAction order={row} businessName={businessName} /><Link className="icon-button" to={`/admin/pedidos/${row.id}`} aria-label={`Ver ${row.display_number}`}><Eye className="h-4 w-4" aria-hidden /></Link></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:hidden" aria-busy={query.isFetching}>
            {rows.map((row) => (
              <article
                className="surface-card group block p-4 transition duration-150 hover:border-stone-300"
                key={row.id}
              >
                <Link to={`/admin/pedidos/${row.id}`} className="block" aria-label={`Ver ${row.display_number}`}>
                <div className="flex flex-col items-start gap-1">
                  <strong className="whitespace-nowrap font-display text-lg font-bold text-stone-950">{row.display_number}</strong>
                  <AdminOrderStatus order={row} />
                </div>
                <div className="mt-4 min-w-0">
                  {row.replaces_order_id?<p className="mb-1 text-xs text-amber-800">Pedido de reemplazo · misma operación comercial</p>:null}
                  <p className="truncate font-semibold text-stone-900">{row.customer_name}</p>
                  <p className="mt-0.5 truncate text-xs text-stone-500">{row.customer_phone}</p>
                </div>
                <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-t border-stone-100 pt-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-700">{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}</p>
                    <p className="mt-0.5 truncate text-xs text-stone-500">{new Date(row.created_at).toLocaleString('es-AR')}</p>
                  </div>
                  <strong className="whitespace-nowrap text-right text-sm tabular-nums text-stone-950">
                    {formatMoney(row.total_cents, row.currency_code)}
                  </strong>
                </div>
                </Link>
                <div className="mt-3 flex justify-end"><OrderWhatsAppAction order={row} businessName={businessName} showLabel /></div>
              </article>
            ))}
          </div>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-stone-500">{query.data?.count ?? 0} resultados</p>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <button className="button-secondary" disabled={page === 0 || query.isFetching} onClick={() => setPage((value) => value - 1)}>Anterior</button>
              <button className="button-secondary" disabled={query.isFetching || (page + 1) * PAGE_SIZE >= (query.data?.count ?? 0)} onClick={() => setPage((value) => value + 1)}>Siguiente</button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
