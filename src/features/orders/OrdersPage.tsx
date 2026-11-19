import { AdminOrderStatus } from './CommerceOrderStatus'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, Eye, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { z } from 'zod'
import { EmptyState, ErrorPanel } from '../../components/Feedback'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
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
import { useStageOneFeatures } from '../restaurants/stage-one-features'
import { useSellerDirectory } from '../sellers/seller-directory'
import { formatDeliveryDate } from '../delivery/delivery-schedule'
import { adminOrderSchema, statusLabel, type AdminOrderRow } from './orderSchemas'
import { OrderWhatsAppAction } from './OrderWhatsAppAction'
import { OrderAcceptAction } from './OrderAcceptAction'
import { acceptanceOrder, useOrderUpdates } from './orderAcceptance'
import { orderCommercialReport } from './inventoryOrder'
import { activeOrderDatePreset, orderDatePresetLabels, orderDatePresets, parseOrderListFilters } from './orderFilters'
import './order-workspace.css'

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
  const { features } = useStageOneFeatures(restaurantId)
  const sellers = useSellerDirectory(features.sellers ? restaurantId : undefined)
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
  const seller = features.sellers ? parsed?.filters.seller ?? '' : ''
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
      seller,
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
      if (seller) request = seller === 'direct' ? request.is('seller_id', null) : request.eq('seller_id', seller)
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
  if (restaurant.isLoading || !datesReady) return <AdminLoading label="Cargando pedidos…" />
  if (query.isLoading) return <>
    <PageHeader title="Pedidos" description="Consultá, aceptá y coordiná tus pedidos." />
    <AdminLoading label="Cargando pedidos…" variant="list" />
  </>
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
        if (seller) request = seller === 'direct' ? request.is('seller_id', null) : request.eq('seller_id', seller)
        const filter = orderSearchFilter(debouncedSearch)
        if (filter) request = request.ilike(filter.field, `%${filter.value}%`)
        const { data, error: loadError } = await request
        if (loadError) throw loadError
        const batch = z.array(adminOrderSchema).parse(data)
        exported.push(...batch)
        if (batch.length < batchSize) break
      }
      const report = exported.map(order => ({
        ...orderCommercialReport(order),
        ...(features.sellers ? { vendedor: order.seller_name ?? '' } : {}),
        ...(features.delivery_schedule ? { entrega_estimada: order.estimated_delivery_date ?? '' } : {}),
      }))
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
  const displayDate = (date: string) => date.split('-').reverse().join('/')
  const dateLabel = dates.from === dates.to ? displayDate(dates.from) : `${displayDate(dates.from)} — ${displayDate(dates.to)}`
  const hasActiveFilters = Boolean(search || status || fulfillment || seller || activePreset !== 'today')

  return (
    <AdminDataWorkspace className="orders-workspace">
      <PageHeader
        title="Pedidos"
        description="Consultá, aceptá y coordiná tus pedidos."
        actions={<button
          className="button-secondary orders-export"
          title="El CSV conserva los importes originales y separa los vigentes para no sumar dos veces un reemplazo."
          disabled={!rows.length || exporting || query.isFetching || search !== debouncedSearch || Boolean(dateError)}
          onClick={() => void exportCsv()}
        >
          <Download className="h-4 w-4" aria-hidden />
          <span>{exporting ? 'Exportando…' : 'Exportar resultados'}</span>
        </button>}
      />
      {exportError ? <InlineFeedback tone="error" className="mb-4">{exportError}</InlineFeedback> : null}
      <FilterBar className="order-filters">
        <div className="order-filter-fields">
        <label className="field order-filter-search">
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
        {features.sellers && (sellers.data?.length || seller) ? <label className="field order-filter-seller">
          <span>Vendedor</span>
          <select value={seller} onChange={event => updateFilters({ seller: event.target.value || null })}>
            <option value="">Todos</option>
            <option value="direct">Venta directa</option>
            {sellers.data?.map(person => <option key={person.id} value={person.id}>{person.name}{person.active ? '' : ' (inactivo)'}</option>)}
          </select>
        </label> : null}
        </div>
        <div className="order-filter-dates">
          <div className="order-date-presets" role="group" aria-label="Período del pedido">
            {orderDatePresetLabels.map((preset) => (
              <button
                type="button"
                className="button-secondary"
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
            {activePreset === 'custom' ? <span className="order-date-current">Personalizado</span> : null}
          </div>
        <details className="admin-disclosure order-date-custom" open={Boolean(dateError) || undefined}>
          <summary><span>Fechas personalizadas</span><span className="order-date-summary">{dateLabel}</span></summary>
          <div className="order-date-fields">
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
        </div>
      </FilterBar>
      {search !== debouncedSearch ? <p className="mb-3 text-xs text-stone-500" role="status">Buscando…</p> : query.isFetching ? <p className="mb-3 text-xs text-stone-500" role="status">Actualizando pedidos…</p> : null}
      <AdminDataRegion aria-label="Resultados de pedidos">
      {dateError ? (
        <InlineFeedback tone="error" className="mb-5">{dateError}</InlineFeedback>
      ) : rows.length === 0 ? (
        <EmptyState
          title={hasActiveFilters ? 'No hay pedidos para estos filtros' : 'Todavía no hay pedidos de hoy'}
          description={hasActiveFilters ? 'Probá otro período o cambiá los filtros.' : 'Los pedidos nuevos aparecerán automáticamente.'}
        />
      ) : (
        <>
          <div className="admin-data-scroll">
          <div className="admin-table-shell hidden overflow-hidden xl:block" aria-busy={query.isFetching}>
            <table className="data-table orders-table">
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Modalidad</th>
                  <th scope="col" className="text-right">Total</th>
                  <th scope="col">Creado</th>
                  <th scope="col"><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="order-row-id font-display font-bold text-stone-950"><span>{row.display_number}</span>{row.seller_name ? <small className="block break-words font-normal text-stone-500">{row.seller_name}</small> : null}</td>
                    <td><strong className="block text-stone-900">{row.customer_name}</strong><small className="text-stone-500">{row.customer_phone}</small></td>
                    <td><AdminOrderStatus order={row} />{row.replaces_order_id?<small className="mt-1 block text-stone-500">Pedido de reemplazo</small>:null}</td>
                    <td className="text-stone-600">{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}{row.estimated_delivery_date ? <small className="block">{formatDeliveryDate(row.estimated_delivery_date)} · estimada</small> : null}</td>
                    <td className="whitespace-nowrap text-right font-bold tabular-nums text-stone-950">{formatMoney(row.total_cents, row.currency_code)}</td>
                    <td className="text-stone-500"><time dateTime={row.created_at}>{new Date(row.created_at).toLocaleString('es-AR')}</time></td>
                    <td><div className="order-row-actions"><OrderAcceptAction order={acceptanceOrder(row)} /><OrderWhatsAppAction order={row} businessName={businessName} /><Link className="icon-button" to={`/admin/pedidos/${row.id}`} state={detailState} aria-label={`Ver ${row.display_number}`}><Eye className="h-4 w-4" aria-hidden /></Link></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:hidden" aria-busy={query.isFetching}>
            {rows.map((row) => (
              <article
                className="surface-card order-result-card"
                key={row.id}
              >
                <Link to={`/admin/pedidos/${row.id}`} state={detailState} className="block" aria-label={`Ver ${row.display_number}`}>
                <div className="order-card-head">
                  <strong className="font-display text-base font-bold text-stone-950">{row.display_number}</strong>
                  <strong className="text-right tabular-nums text-stone-950">{formatMoney(row.total_cents, row.currency_code)}</strong>
                </div>
                <AdminOrderStatus order={row} />
                <div className="order-card-customer">
                  {row.replaces_order_id?<p className="mb-1 text-xs text-amber-800">Pedido de reemplazo · misma operación comercial</p>:null}
                  <p className="font-semibold text-stone-900">{row.customer_name}</p>
                  <p className="text-xs text-stone-600">{row.customer_phone}</p>
                  {row.seller_name ? <p className="mt-1 text-xs text-stone-500">Vendedor: {row.seller_name}</p> : null}
                </div>
                <div className="order-card-fulfillment">
                  <span className="text-sm font-medium text-stone-700">{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}</span>
                  {row.estimated_delivery_date ? <span className="text-xs text-stone-600">{formatDeliveryDate(row.estimated_delivery_date)} · estimada</span> : null}
                  <time className="text-xs text-stone-600" dateTime={row.created_at}>{new Date(row.created_at).toLocaleString('es-AR')}</time>
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
