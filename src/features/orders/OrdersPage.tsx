import { AdminOrderStatus } from './CommerceOrderStatus'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, Eye, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { z } from 'zod'
import { EmptyState, ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { FilterBar } from '../../components/FilterBar'
import { AdminDataRegion, AdminDataWorkspace } from '../../components/AdminDataWorkspace'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { orderSearchFilter } from '../../lib/orders'
import { queryKeys } from '../../lib/queryKeys'
import { supabase } from '../../lib/supabase/client'
import { dateInTimeZone, dateRangeForLocalDates } from '../../lib/timezone'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { adminOrderSchema, statusLabel, type AdminOrderRow } from './orderSchemas'
import { OrderWhatsAppAction } from './OrderWhatsAppAction'
import { OrderAcceptAction } from './OrderAcceptAction'
import { acceptanceOrder, useOrderUpdates } from './orderAcceptance'
import { orderCommercialReport } from './inventoryOrder'
import { activeOrderDatePreset, orderDatePresetLabels, orderDatePresets, parseOrderListFilters } from './orderFilters'

const PAGE_SIZE = 25

export function orderDateRangeError(from: string, to: string) {
  if (!from || !to || from <= to) return null
  return 'La fecha Desde no puede ser posterior a la fecha Hasta.'
}

export function OrdersPage() {
  const scope = useRestaurantScope()
  const restaurant = useRestaurant(scope.selected?.id)
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [referenceNow, setReferenceNow] = useState(() => new Date())
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const restaurantId = scope.selected?.id
  const restaurantTimeZone = restaurant.data?.timezone
  useOrderUpdates(restaurantId)

  useEffect(() => {
    const timer = window.setInterval(() => setReferenceNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const today = restaurantTimeZone ? dateInTimeZone(referenceNow, restaurantTimeZone) : ''
  const paramsText = searchParams.toString()
  const parsed = useMemo(
    () => today ? parseOrderListFilters(new URLSearchParams(paramsText), today) : null,
    [paramsText, today],
  )
  const search = parsed?.filters.search ?? ''
  const debouncedSearch = useDebouncedValue(search, 300)
  const status = parsed?.filters.status ?? ''
  const fulfillment = parsed?.filters.fulfillment ?? ''
  const page = parsed?.filters.page ?? 0
  const dates = { from: parsed?.filters.from ?? '', to: parsed?.filters.to ?? '' }
  const presets = useMemo(
    () => restaurantTimeZone ? orderDatePresets(referenceNow, restaurantTimeZone) : null,
    [referenceNow, restaurantTimeZone],
  )
  const activePreset = presets ? activeOrderDatePreset(dates.from, dates.to, presets) : 'custom'

  useEffect(() => {
    if (!parsed || parsed.canonical.toString() === paramsText) return
    setSearchParams(parsed.canonical, { replace: true })
  }, [paramsText, parsed, setSearchParams])

  const datesReady = Boolean(scope.selected && restaurant.data && dates.from && dates.to)
  const dateError = datesReady ? orderDateRangeError(dates.from, dates.to) : null

  function updateFilters(values: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(parsed?.canonical ?? searchParams)
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    if (resetPage) next.delete('page')
    setSearchParams(next, { replace: true })
  }

  function changePage(nextPage: number) {
    updateFilters({ page: nextPage > 0 ? String(nextPage + 1) : null }, false)
  }
  const query = useQuery<{ rows: AdminOrderRow[]; count: number }>({
    queryKey: [
      ...queryKeys.orders(scope.selected?.id),
      restaurant.data?.timezone,
      page,
      status,
      fulfillment,
      debouncedSearch,
      dates.from,
      dates.to,
    ],
    enabled: datesReady && !dateError && search === debouncedSearch,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === scope.selected?.id ? keepPreviousData(previous) : undefined,
    queryFn: async ({ signal }) => {
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
      const filter = orderSearchFilter(debouncedSearch)
      if (filter) request = request.ilike(filter.field, `%${filter.value}%`)
      const { data, error, count } = await request.abortSignal(signal)
      if (error) throw new Error('No se pudieron cargar los pedidos.')
      return { rows: z.array(adminOrderSchema).parse(data), count: count ?? 0 }
    },
  })

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
        const filter = orderSearchFilter(debouncedSearch)
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

  const returnTo = `${location.pathname}${location.search}`
  const detailState = { ordersReturnTo: returnTo }

  return (
    <AdminDataWorkspace className="orders-workspace">
      <PageHeader
        eyebrow="Tiempo real"
        title="Pedidos"
        description="Aceptá tus pedidos, reservá las unidades y contactá a cada cliente."
      />
      {exportError ? (
        <p className="form-error mb-4" role="alert">
          {exportError}
        </p>
      ) : null}
      <FilterBar className="orders-filter-bar mb-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
        <label className="field min-w-0">
          <span>Buscar</span>
          <span className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <input
              className="!pl-9"
              value={search}
              onChange={(event) => updateFilters({ q: event.target.value || null })}
              placeholder="Cliente, teléfono o número"
            />
          </span>
        </label>
        <label className="field min-w-0">
          <span>Estado</span>
          <select
            value={status}
            onChange={(event) => updateFilters({ status: event.target.value || null })}
          >
            <option value="">Todos</option>
            {Object.entries(statusLabel).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field min-w-0">
          <span>Modalidad</span>
          <select
            value={fulfillment}
            onChange={(event) => updateFilters({ fulfillment: event.target.value || null })}
          >
            <option value="">Todas</option>
            <option value="delivery">Envío</option>
            <option value="pickup">Retiro</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            className="button-secondary w-full whitespace-nowrap md:w-auto"
            title="El CSV conserva los importes originales y separa los vigentes para no sumar dos veces un reemplazo."
            disabled={!rows.length || exporting || query.isFetching || search !== debouncedSearch || Boolean(dateError)}
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" aria-hidden />
            {exporting ? 'Exportando…' : 'Exportar resultados'}
          </button>
        </div>
        <div className="lg:col-span-4">
          <span className="mb-2 block text-xs font-medium text-stone-600">Período</span>
          <div className="flex flex-wrap gap-2" aria-label="Período del pedido">
            {orderDatePresetLabels.map((preset) => (
              <button
                type="button"
                className="button-secondary min-h-9 px-3 py-1.5"
                aria-pressed={activePreset === preset.value}
                key={preset.value}
                onClick={() => {
                  const range = presets?.[preset.value]
                  if (range) updateFilters({ from: range.from, to: range.to })
                }}
              >
                {preset.label}
              </button>
            ))}
            {activePreset === 'custom' ? <span className="inline-flex min-h-9 items-center rounded-lg bg-stone-100 px-3 text-xs font-semibold text-stone-700">Personalizado</span> : null}
          </div>
        </div>
        <details className="admin-disclosure lg:col-span-4" open={Boolean(dateError) || undefined}>
          <summary className="flex flex-wrap items-center gap-x-3 gap-y-1"><span>Fechas personalizadas</span><span className="text-xs font-normal text-stone-500">{dates.from === dates.to ? dates.from.split('-').reverse().join('/') : `${dates.from.split('-').reverse().join('/')} — ${dates.to.split('-').reverse().join('/')}`}</span></summary>
          <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="field min-w-0">
          <span>Desde</span>
          <input
            type="date"
            value={dates.from}
            max={dates.to}
            onChange={(event) => {
              const from = event.target.value
              if (from) updateFilters({ from, to: dates.to < from ? from : dates.to })
            }}
          />
        </label>
        <label className="field min-w-0">
          <span>Hasta</span>
          <input
            type="date"
            value={dates.to}
            min={dates.from}
            onChange={(event) => {
              const to = event.target.value
              if (to) updateFilters({ from: dates.from > to ? to : dates.from, to })
            }}
          />
        </label>
          </div>
        </details>
      </FilterBar>
      {search !== debouncedSearch ? <p className="mb-3 text-xs text-stone-500" role="status">Buscando…</p> : query.isFetching ? <p className="mb-3 text-xs text-stone-500" role="status">Actualizando pedidos…</p> : null}
      <AdminDataRegion aria-label="Resultados de pedidos">
      {dateError ? (
        <p className="form-error mb-5" role="alert">{dateError}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No hay pedidos para estos filtros"
          description="Los pedidos nuevos aparecerán automáticamente."
        />
      ) : (
        <>
          <div className="admin-data-scroll">
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
                    <td className="whitespace-nowrap font-display font-bold text-stone-950">{row.display_number}</td>
                    <td><strong className="block text-stone-900">{row.customer_name}</strong><small className="text-stone-500">{row.customer_phone}</small></td>
                    <td><AdminOrderStatus order={row} />{row.replaces_order_id?<small className="mt-1 block text-stone-500">Pedido de reemplazo</small>:null}</td>
                    <td className="text-stone-600">{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}</td>
                    <td className="whitespace-nowrap text-right font-bold tabular-nums text-stone-950">{formatMoney(row.total_cents, row.currency_code)}</td>
                    <td className="whitespace-nowrap text-stone-500">{new Date(row.created_at).toLocaleString('es-AR')}</td>
                    <td><div className="flex flex-wrap items-center justify-end gap-2"><OrderAcceptAction order={acceptanceOrder(row)} /><OrderWhatsAppAction order={row} businessName={businessName} /><Link className="icon-button" to={`/admin/pedidos/${row.id}`} state={detailState} aria-label={`Ver ${row.display_number}`}><Eye className="h-4 w-4" aria-hidden /></Link></div></td>
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
                <Link to={`/admin/pedidos/${row.id}`} state={detailState} className="block" aria-label={`Ver ${row.display_number}`}>
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
                <div className="mt-3 flex flex-wrap items-start justify-end gap-2"><OrderAcceptAction order={acceptanceOrder(row)} /><OrderWhatsAppAction order={row} businessName={businessName} showLabel /></div>
              </article>
            ))}
          </div>
          </div>
          <div className="admin-data-pagination mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-stone-500">{query.data?.count ?? 0} resultados</p>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <button className="button-secondary" disabled={page === 0 || query.isFetching} onClick={() => changePage(page - 1)}>Anterior</button>
              <button className="button-secondary" disabled={query.isFetching || (page + 1) * PAGE_SIZE >= (query.data?.count ?? 0)} onClick={() => changePage(page + 1)}>Siguiente</button>
            </div>
          </div>
        </>
      )}
      </AdminDataRegion>
    </AdminDataWorkspace>
  )
}
