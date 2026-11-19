import { Link } from 'react-router'
import type { z } from 'zod'
import { operationLabels, type inventoryOperationSchema, type InventoryItem } from './inventory'

type StockHistoryProps = {
  operations: z.infer<typeof inventoryOperationSchema>[]
  items: InventoryItem[]
}

export function StockHistory({ operations, items }: StockHistoryProps) {
  const productNames = new Map(items.map(item => [item.productId, item.name]))

  return (
    <details className="admin-disclosure stock-tool">
      <summary>Historial de movimientos</summary>
      <section aria-labelledby="stock-history-heading">
        <h2 className="form-card-title" id="stock-history-heading">{operations.length === 1 ? 'Último movimiento' : operations.length ? `Últimos ${operations.length} movimientos` : 'Movimientos recientes'}</h2>
        <p className="stock-history-explanation">Se muestran hasta 100 operaciones. Las reservas afectan disponible y las entregas afectan existencia. Una devolución no confirma un reintegro de dinero.</p>
        {operations.length ? (
          <table className="data-table stock-history-table" aria-labelledby="stock-history-heading" role="table">
            <thead role="rowgroup"><tr role="row">
              <th scope="col">Acción</th>
              <th scope="col">Fecha</th>
              <th scope="col">Motivo, referencia y cantidades</th>
              <th scope="col">Responsable</th>
              <th scope="col">Pedido</th>
            </tr></thead>
            <tbody role="rowgroup">
              {operations.map(operation => (
                <tr key={operation.id} role="row">
                  <th scope="row" role="rowheader">{operationLabels[operation.kind] ?? operation.kind}</th>
                  <td role="cell"><span className="stock-history-label" aria-hidden>Fecha</span><time dateTime={operation.createdAt}>{new Date(operation.createdAt).toLocaleString('es-AR')}</time></td>
                  <td role="cell">
                    <span className="stock-history-label" aria-hidden>Motivo y cantidades</span>
                    {operation.reason}
                    {operation.kind === 'external_sale' && operation.externalReference ? <p className="mt-1">Canal y referencia: <span>{operation.externalReference}</span></p> : null}
                    {operation.movements.length ? (
                      <details className="stock-history-movements">
                        <summary>Ver cantidades</summary>
                        <ul className="space-y-1">
                          {operation.movements.map(movement => (
                            <li key={movement.productId}>{productNames.get(movement.productId) ?? 'Producto archivado'}: existencia {movement.deltaOnHand}, reserva {movement.deltaReserved}{movement.returnedQuantity !== '0' ? `, recibido en devolución ${movement.returnedQuantity}` : ''}. Saldo: {movement.onHandAfter}.</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td role="cell"><span className="stock-history-label" aria-hidden>Responsable</span>{operation.actorName || (operation.actorUserId ? 'Operador registrado' : 'Sistema de pagos')}</td>
                  <td role="cell"><span className="stock-history-label" aria-hidden>Pedido</span>{operation.orderId ? <Link className="stock-history-link" to={`/admin/pedidos/${operation.orderId}`}>Ver pedido</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="stock-empty">Todavía no hay movimientos registrados.</p>}
      </section>
    </details>
  )
}
