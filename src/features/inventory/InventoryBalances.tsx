import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AdminDataRegion } from '../../components/AdminDataWorkspace'
import { InlineFeedback, AdminLoading } from '../../components/AdminFeedback'
import { hasNoStock, type CountDraft, type InventoryItem } from './inventory'

const overscan = 8
const minimumVirtualRows = 48
const initialViewportHeight = 640
const quantityFormatter = new Intl.NumberFormat('es-AR')

function formattedQuantity(value: string | null) {
  return value === null ? '—' : quantityFormatter.format(BigInt(value))
}

type InventoryBalancesProps = {
  items: InventoryItem[]
  isAdmin: boolean
  counting: boolean
  allItemsLoaded: boolean
  counts: CountDraft
  disabled: boolean
  search: string
  debouncedSearch: string
  onSearchChange: (search: string) => void
  onCountChange: (id: string, quantity: string) => void
  hasNextPage: boolean
  loadingNextPage: boolean
  searching: boolean
  searchError: string | null
  onNextPage: () => void
  onRetry: () => void
}

export function InventoryBalances({
  items, isAdmin, counting, allItemsLoaded, counts, disabled, search, debouncedSearch,
  onSearchChange, onCountChange, hasNextPage, loadingNextPage, searching, searchError, onNextPage, onRetry,
}: InventoryBalancesProps) {
  const inventoryViewport = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [compact, setCompact] = useState(false)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: initialViewportHeight })

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setCompact(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (inventoryViewport.current) inventoryViewport.current.scrollTop = 0
    setViewport(current => ({ ...current, scrollTop: 0 }))
  }, [debouncedSearch])

  function clearSearch() {
    onSearchChange('')
    searchInput.current?.focus()
  }

  const rowHeight = compact ? (isAdmin ? 184 : 140) : 76
  const virtualized = items.length >= minimumVirtualRows
  const firstRow = virtualized ? Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan) : 0
  const lastRow = virtualized ? Math.min(items.length, firstRow + Math.ceil(viewport.height / rowHeight) + overscan * 2) : items.length
  const columnCount = isAdmin ? 5 : 4
  const hasEmptyState = items.length === 0

  return (
    <AdminDataRegion className="form-card admin-inventory-balances" aria-labelledby="inventory-balances-title">
      <div className="stock-balances-header">
        <div>
          <h2 className="form-card-title" id="inventory-balances-title">Existencias</h2>
          <p>El stock disponible es el total menos las unidades reservadas.</p>
        </div>
        <div className="stock-search w-full sm:max-w-xs">
          <label className="field">
            <span>Buscar producto o código</span>
            <input ref={searchInput} value={search} maxLength={120} disabled={counting} onChange={event => onSearchChange(event.target.value)} placeholder="Buscar en inventario" />
          </label>
          {search && !counting ? <button className="stock-clear-search" type="button" onClick={clearSearch}>Limpiar</button> : null}
        </div>
      </div>
      {counting && !allItemsLoaded ? <p className="mt-3 text-sm text-amber-800" role="status">Cargando el catálogo completo para garantizar un conteo sin productos omitidos…</p> : null}
      {!counting && !(searching && hasEmptyState) ? <p className="stock-result-count" role="status">{searching ? 'Buscando productos…' : `${items.length} ${items.length === 1 ? 'producto cargado' : 'productos cargados'}${hasNextPage ? ' · Hay más resultados' : ''}`}</p> : null}
      {searchError ? <InlineFeedback tone="error" className="mt-3"><p>{searchError}</p><button className="button-secondary mt-2" type="button" onClick={onRetry}>Reintentar carga</button></InlineFeedback> : null}
      {hasEmptyState && searching && !counting && !searchError ? <AdminLoading label="Buscando productos…" variant="list" /> : null}
      {hasEmptyState && !searching && !searchError ? <div className="stock-empty">
        <p className="font-semibold">{debouncedSearch ? 'No encontramos productos' : 'Todavía no hay productos'}</p>
        <p>{debouncedSearch ? 'Probá otro nombre o código.' : 'Los productos de tu catálogo se muestran acá.'}</p>
        {debouncedSearch ? <button className="button-secondary" type="button" onClick={clearSearch}>Ver todos los productos</button> : null}
      </div> : null}
      {!hasEmptyState ? <div
        ref={inventoryViewport}
        className={clsx('stock-balances-list', virtualized && 'stock-balances-list--virtual')}
        tabIndex={virtualized ? 0 : undefined}
        aria-label={virtualized ? 'Lista desplazable de existencias' : undefined}
        role={virtualized ? 'region' : undefined}
        aria-busy={searching}
        onScroll={virtualized ? event => setViewport({ scrollTop: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || initialViewportHeight }) : undefined}
      >
        <table className="data-table inventory-balances-table" role="table" aria-label="Existencias de productos" aria-rowcount={items.length + 1}>
          <thead className={virtualized ? 'sticky top-0 z-10' : undefined} role="rowgroup"><tr role="row" aria-rowindex={1}>
            <th scope="col">Producto</th>
            <th scope="col">Disponible</th>
            <th scope="col">Reservado</th>
            <th scope="col">Existencia</th>
            {isAdmin ? <th scope="col">{counting ? 'Conteo físico' : <span className="sr-only">Editar</span>}</th> : null}
          </tr></thead>
          <tbody role="rowgroup">
            {firstRow > 0 ? <tr className="inventory-virtual-spacer" aria-hidden="true"><td colSpan={columnCount} style={{ height: firstRow * rowHeight }} /></tr> : null}
            {items.slice(firstRow, lastRow).map((item, index) => {
              const depleted = hasNoStock(item)
              return <tr key={item.productId} role="row" aria-rowindex={firstRow + index + 2} data-inventory-row style={virtualized ? { height: rowHeight } : undefined}>
                <td className="inventory-product" role="cell">
                  <span className="stock-product-name" title={item.name}>{item.name}</span>
                  {item.archived ? <span className="stock-archived">Archivado</span> : null}
                  <span className="inventory-code" title={item.code}>{item.code}</span>
                </td>
                <td className={clsx('inventory-quantity stock-available', depleted && 'stock-available-depleted', !item.initialized && 'stock-available-missing')} role="cell">
                  <span className="inventory-balance-label" aria-hidden="true">Disponible</span>
                  {!item.initialized ? <span className="stock-quantity-state">Sin cargar</span> : formattedQuantity(item.available)}
                  {depleted ? <span className="stock-quantity-state stock-quantity-out">Agotado</span> : null}
                </td>
                <td className="inventory-quantity" role="cell"><span className="inventory-balance-label" aria-hidden="true">Reservado</span>{formattedQuantity(item.reserved)}</td>
                <td className="inventory-quantity stock-total" role="cell"><span className="inventory-balance-label" aria-hidden="true">Total</span>{formattedQuantity(item.onHand)}</td>
                {isAdmin && !counting ? <td className="inventory-edit" role="cell"><Link className="inventory-edit-link font-semibold text-orange-700 underline" aria-label={`Editar stock de ${item.name}`} to={`/admin/catalogo/productos/${item.productId}`}>Editar stock</Link></td> : null}
                {isAdmin && counting ? <td className="inventory-count" role="cell"><span className="inventory-balance-label" aria-hidden="true">Conteo físico</span><input className="w-28 rounded-lg border p-2" aria-label={`Conteo de ${item.name}`} inputMode="numeric" value={counts[item.productId]?.quantity ?? ''} disabled={disabled} onChange={event => onCountChange(item.productId, event.target.value)} /></td> : null}
              </tr>
            })}
            {lastRow < items.length ? <tr className="inventory-virtual-spacer" aria-hidden="true"><td colSpan={columnCount} style={{ height: (items.length - lastRow) * rowHeight }} /></tr> : null}
          </tbody>
        </table>
      </div> : null}
      {hasNextPage ? <div className="mt-4 flex justify-center"><button className="button-secondary" type="button" disabled={loadingNextPage} onClick={onNextPage}>{loadingNextPage ? 'Cargando…' : counting ? 'Cargar catálogo completo' : 'Ver más productos'}</button></div> : null}
    </AdminDataRegion>
  )
}
