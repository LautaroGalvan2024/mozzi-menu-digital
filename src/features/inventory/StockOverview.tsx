import { ClipboardList, Package, PackageMinus, Plus, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { hasNoStock, type InventoryItem } from './inventory'

type StockOverviewProps = {
  items: InventoryItem[]
  loading: boolean
  failed: boolean
  modeLabel: string
  paused: boolean
  isAdmin: boolean
  refreshing: boolean
  canRecordMovement: boolean
  movementDisabled: boolean
  onRefresh: () => void
  onNewMovement: () => void
}

export function StockOverview({
  items, loading, failed, modeLabel, paused, isAdmin, refreshing, canRecordMovement, movementDisabled, onRefresh, onNewMovement,
}: StockOverviewProps) {
  const counts = items.reduce((summary, item) => {
    if (!item.initialized) summary.unconfigured++
    else if (hasNoStock(item)) summary.outOfStock++
    else summary.inStock++
    return summary
  }, { inStock: 0, outOfStock: 0, unconfigured: 0 })
  const metrics = [
    { label: 'Con unidades disponibles', value: counts.inStock, icon: Package, tone: 'available' },
    { label: 'Agotados', value: counts.outOfStock, icon: PackageMinus, tone: 'depleted' },
    { label: 'Sin cantidad cargada', value: counts.unconfigured, icon: ClipboardList, tone: 'missing' },
  ]

  return (
    <div className="stock-overview">
      <div className="stock-status-bar">
        <div className="stock-status-context">
          <span className="stock-status-label">Control de stock</span>
          <span className="stock-mode" data-mode={paused ? 'paused' : modeLabel === 'Activo' ? 'active' : 'inactive'}>{modeLabel}</span>
          {paused ? <p>Las operaciones afectadas están pausadas. Los movimientos y las reservas se conservan.</p> : null}
        </div>
        <div className="stock-status-actions">
          <button className="button-secondary" type="button" disabled={refreshing} onClick={onRefresh}><RefreshCw size={16} aria-hidden="true" />Actualizar</button>
          {isAdmin ? <Link className="button-secondary" to="/admin/catalogo/productos">Ir a productos</Link> : null}
          {canRecordMovement ? <button className="button-primary" type="button" disabled={movementDisabled} onClick={onNewMovement}><Plus size={17} aria-hidden="true" />Nuevo movimiento</button> : null}
        </div>
      </div>
      <div className="stock-summary">
        <p className="stock-summary-caption" id="stock-summary-caption">Resumen de los productos cargados</p>
        <dl className="stock-metrics" aria-labelledby="stock-summary-caption">
          {metrics.map(({ label, value, icon: Icon, tone }) => (
            <div key={label} className="stock-metric" data-tone={tone}>
              <Icon className="stock-metric-icon" size={18} aria-hidden="true" />
              <dt>{label}</dt>
              <dd aria-label={loading || failed ? 'Dato sin confirmar' : undefined}>{loading || failed ? '—' : value}</dd>
            </div>
          ))}
        </dl>
        <p className="stock-helper">Los productos sin cantidad cargada se pueden pedir sin control de stock.</p>
      </div>
    </div>
  )
}
