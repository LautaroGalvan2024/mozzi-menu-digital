import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { EmptyState, ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { formatMoney } from '../../lib/money'
import { orderSearchFilter } from '../../lib/orders'
import { supabase } from '../../lib/supabase/client'
import { dateInTimeZone, dateRangeForLocalDates } from '../../lib/timezone'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { useRestaurant } from '../restaurants/useRestaurant'
import { adminOrderSchema, statusLabel, type AdminOrderRow } from './orderSchemas'
import { StatusPill } from './OrderStatus'

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

  if (!scope.selected) return <ErrorPanel>Falta seleccionar un restaurante.</ErrorPanel>
  if (restaurant.error || query.error) {
    return <ErrorPanel>{restaurant.error?.message ?? query.error?.message}</ErrorPanel>
  }
  if (restaurant.isLoading || query.isLoading || !datesReady) return <LoadingScreen />
  const rows = dateError ? [] : (query.data?.rows ?? [])

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
      const columns = [
        'display_number',
        'created_at',
        'status',
        'customer_name',
        'customer_phone',
        'fulfillment_type',
        'payment_method_name_snapshot',
        'total_cents',
        'accepted_at',
      ]
      const safe = (value: unknown) => {
        const text = String(value ?? '')
        const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text
        return `"${protectedText.replace(/"/g, '""')}"`
      }
      const csv = [
        columns.join(','),
        ...exported.map((row) =>
          columns.map((column) => safe(row[column as keyof AdminOrderRow])).join(','),
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
        description="Los cambios se actualizan mediante Realtime y siempre respetan RLS."
        actions={
          <button
            className="button-secondary"
            disabled={!rows.length || exporting || Boolean(dateError)}
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" />
            {exporting ? 'Exportando…' : 'Exportar resultados'}
          </button>
        }
      />
      {exportError ? (
        <p className="form-error mb-4" role="alert">
          {exportError}
        </p>
      ) : null}
      <section className="mb-5 grid gap-3 rounded-3xl border border-stone-200 bg-white p-4 md:grid-cols-6">
        <label className="field md:col-span-2">
          <span>Buscar</span>
          <span className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-stone-400" />
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
        <label className="field">
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
        <label className="field">
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
        <label className="field">
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
        <label className="field">
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
      </section>
      {dateError ? (
        <p className="form-error mb-5" role="alert">{dateError}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No hay pedidos para estos filtros"
          description="Los pedidos nuevos aparecerán automáticamente."
        />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-3xl border border-stone-200 bg-white md:block">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Estado</th>
                  <th>Modalidad</th>
                  <th>Total</th>
                  <th>Creado</th>
                  <th><span className="sr-only">Abrir</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="font-bold">{row.display_number}</td>
                    <td><strong className="block">{row.customer_name}</strong><small>{row.customer_phone}</small></td>
                    <td><StatusPill status={row.status} /></td>
                    <td>{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}</td>
                    <td className="font-semibold">{formatMoney(row.total_cents, row.currency_code)}</td>
                    <td>{new Date(row.created_at).toLocaleString('es-AR')}</td>
                    <td><Link className="icon-button" to={`/admin/pedidos/${row.id}`} aria-label={`Ver ${row.display_number}`}><Eye className="h-4 w-4" /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 md:hidden">
            {rows.map((row) => (
              <Link to={`/admin/pedidos/${row.id}`} className="block rounded-2xl border border-stone-200 bg-white p-4" key={row.id}>
                <div className="flex justify-between"><strong>{row.display_number}</strong><StatusPill status={row.status} /></div>
                <p className="mt-3 font-semibold">{row.customer_name}</p>
                <div className="mt-2 flex justify-between text-sm text-stone-500"><span>{row.fulfillment_type === 'delivery' ? 'Envío' : 'Retiro'}</span><strong className="text-stone-900">{formatMoney(row.total_cents, row.currency_code)}</strong></div>
              </Link>
            ))}
          </div>
          <div className="mt-5 flex items-center justify-between">
            <p className="text-sm text-stone-500">{query.data?.count ?? 0} resultados</p>
            <div className="flex gap-2">
              <button className="button-secondary" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button>
              <button className="button-secondary" disabled={(page + 1) * PAGE_SIZE >= (query.data?.count ?? 0)} onClick={() => setPage((value) => value + 1)}>Siguiente</button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
