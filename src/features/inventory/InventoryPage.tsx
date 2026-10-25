import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { ErrorPanel, LoadingScreen } from '../../components/Feedback'
import { PageHeader } from '../../components/PageHeader'
import { supabase } from '../../lib/supabase/client'
import { useRestaurantScope } from '../restaurants/RestaurantScope'
import { countedQuantity, countRows, inventoryError, inventorySchema, operationLabels, readCountDraft, type CountDraft } from './inventory'

const uuid = z.string().uuid()
const businessPolicy = z.object({
  unitModel: z.literal('whole_product'), sourceOfTruth: z.literal('app'),
  otherChannels: z.enum(['none', 'record_before_handoff']), returns: z.literal('full_only'),
  acceptance: z.literal('reserve'), delivery: z.literal('physical_handoff'),
  partialDeliveries: z.literal('none'), physicalScope: z.literal('until_handoff_including_transit'),
  acceptedReservationsExpire: z.literal(false),
})
const commandSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('confirm_inventory_business_policy'), args: z.object({ p_restaurant_id: uuid, p_policy: businessPolicy }) }),
  z.object({ name: z.literal('begin_inventory_count'), args: z.object({ p_restaurant_id: uuid, p_operation_id: uuid, p_reason: z.string() }) }),
  z.object({ name: z.literal('finish_inventory_count'), args: z.object({ p_count_id: uuid, p_rows: z.array(z.object({ productId: uuid, quantity: z.string(), countedAt: z.string() })), p_pending_order_ids: z.array(uuid), p_no_movements_confirmed: z.boolean(), p_note: z.string(), p_activate: z.boolean() }) }),
  z.object({ name: z.literal('change_inventory_policy'), args: z.object({ p_restaurant_id: uuid, p_mode: z.enum(['paused', 'enforced']), p_reason: z.string(), p_expected_policy_version: z.number().int().nonnegative() }) }),
  z.object({ name: z.literal('inventory_adjust'), args: z.object({ p_restaurant_id: uuid, p_operation_id: uuid, p_kind: z.enum(['receipt', 'adjustment', 'external_sale']), p_rows: z.array(z.object({ productId: uuid, quantity: z.string(), expectedVersion: z.string() })), p_reason: z.string(), p_external_reference: z.string().optional() }) }),
])
type Command = z.infer<typeof commandSchema>
const pendingKey = (restaurantId: string) => `mozzi:inventory-command:${restaurantId}`
function readPending(restaurantId: string) {
  try {
    const parsed = commandSchema.safeParse(JSON.parse(sessionStorage.getItem(pendingKey(restaurantId)) ?? 'null'))
    return parsed.success ? parsed.data : null
  } catch { return null }
}
const orderSchema = z.object({ id: uuid, display_number: z.string(), status: z.string() })

export function InventoryPage() {
  const scope = useRestaurantScope()
  return <InventoryWorkspace key={scope.selected?.id ?? 'none'} />
}

function InventoryWorkspace() {
  const scope = useRestaurantScope()
  const restaurantId = scope.selected?.id ?? ''
  const isAdmin = scope.selected?.role !== 'order_manager'
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [pending, setPending] = useState<Command | null>(null)
  const [reason, setReason] = useState('')
  const [otherChannels, setOtherChannels] = useState<'none' | 'record_before_handoff'>('none')
  const [businessAccepted, setBusinessAccepted] = useState(false)
  const [counts, setCounts] = useState<CountDraft>({})
  const [noMovements, setNoMovements] = useState(false)
  const [activate, setActivate] = useState(false)
  const [reviewedOrders, setReviewedOrders] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [movementKind, setMovementKind] = useState<'receipt' | 'adjustment' | 'external_sale'>('receipt')
  const [productId, setProductId] = useState('')
  const [movementQuantity, setMovementQuantity] = useState('')
  const [movementReason, setMovementReason] = useState('')
  const [externalReference, setExternalReference] = useState('')
  const query = useQuery({
    queryKey: ['inventory', restaurantId], enabled: Boolean(restaurantId),
    queryFn: async () => {
      let after: string | undefined
      let combined: z.infer<typeof inventorySchema> | undefined
      for (let page = 0; page < 10; page++) {
        const result = await supabase.rpc('get_inventory', { p_restaurant_id: restaurantId, ...(after ? { p_after: after } : {}), p_limit: 500 })
        if (result.error) throw new Error(inventoryError(result.error))
        const parsed = inventorySchema.parse(result.data)
        if (!combined) combined = parsed
        else {
          if (parsed.policy.version !== combined.policy.version) throw new Error('El inventario cambió mientras se cargaba. Actualizá la pantalla.')
          combined.items.push(...parsed.items)
        }
        if (!parsed.nextCursor) return combined
        after = parsed.nextCursor
      }
      throw new Error('El catálogo supera los 5.000 productos admitidos en esta pantalla. No se cargó una lista incompleta.')
    },
  })
  const countId = query.data?.policy.cutoverId
  const openOrders = useQuery({
    queryKey: ['inventory-pending-orders', restaurantId, countId], enabled: Boolean(countId && isAdmin),
    queryFn: async () => {
      const all: z.infer<typeof orderSchema>[] = []
      let after: string | undefined
      for (let page = 0; page < 10; page++) {
        let request = supabase.from('orders').select('id,display_number,status').eq('restaurant_id', restaurantId).in('status', ['generated', 'whatsapp_opened', 'accepted']).order('id').limit(500)
        if (after) request = request.gt('id', after)
        const result = await request
        if (result.error) throw new Error('No se pudieron cargar los pedidos pendientes.')
        const rows = z.array(orderSchema).parse(result.data)
        all.push(...rows)
        if (rows.length < 500) return all
        after = rows.at(-1)?.id
      }
      throw new Error('Hay más de 5.000 pedidos pendientes. Revisalos antes del corte.')
    },
  })
  useEffect(() => {
    setPending(readPending(restaurantId)); setError(null); setMessage(null)
    setReason(''); setProductId(''); setBusinessAccepted(false); setReviewedOrders([])
  }, [restaurantId])
  useEffect(() => {
    setCounts(countId ? readCountDraft(restaurantId, countId) : {})
    setNoMovements(false); setActivate(false); setNote(''); setReviewedOrders([])
  }, [restaurantId, countId])

  async function execute(command: Command) {
    if (inFlight.current || !isAdmin) return
    inFlight.current = true; setBusy(true); setError(null); setMessage(null)
    try {
      sessionStorage.setItem(pendingKey(restaurantId), JSON.stringify(command))
      setPending(command)
      const result = await supabase.rpc(command.name, command.args)
      if (result.error) {
        // PostgreSQL has confirmed a rolled-back transaction. Network/transport
        // errors remain recoverable with the same exact operation and payload.
        if (/^(22|23|40|42|P0)/.test(result.error.code ?? '')) {
          sessionStorage.removeItem(pendingKey(restaurantId)); setPending(null)
        }
        if (result.error.code === '40001') await client.invalidateQueries({ queryKey: ['inventory', restaurantId] })
        setError(inventoryError(result.error))
        return
      }
      sessionStorage.removeItem(pendingKey(restaurantId)); setPending(null)
      if (command.name === 'finish_inventory_count') localStorage.removeItem(`mozzi:inventory-count:${restaurantId}:${command.args.p_count_id}`)
      setMessage('Operación registrada.'); setMovementQuantity(''); setMovementReason(''); setExternalReference(''); setReason('')
      await Promise.all([
        client.invalidateQueries({ queryKey: ['inventory', restaurantId] }),
        client.invalidateQueries({ queryKey: ['inventory-pending-orders', restaurantId] }),
        client.invalidateQueries({ queryKey: ['orders', restaurantId] }),
        client.invalidateQueries({ queryKey: ['public-menu'] }),
      ])
    } catch {
      setError('No se pudo confirmar la operación. Conservamos el intento para que puedas reintentarlo sin duplicar movimientos.')
    } finally { inFlight.current = false; setBusy(false) }
  }
  function updateCount(id: string, quantity: string) {
    if (!countId) return
    const next = { ...counts, [id]: countedQuantity(quantity) }
    try {
      localStorage.setItem(`mozzi:inventory-count:${restaurantId}:${countId}`, JSON.stringify(next))
      setCounts(next); setError(null)
    } catch { setError('No se pudo guardar el conteo en este dispositivo. No cierres la pantalla; comprobá que permita guardar datos.') }
  }
  function finishCount() {
    if (!query.data || !countId) return
    try {
      const rows = countRows(query.data.items, counts)
      void execute({ name: 'finish_inventory_count', args: { p_count_id: countId, p_rows: rows, p_pending_order_ids: activate ? reviewedOrders : [], p_no_movements_confirmed: noMovements, p_note: note.trim(), p_activate: activate } })
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Revisá las cantidades.') }
  }
  function recordMovement() {
    const item = query.data?.items.find(row => row.productId === productId)
    if (!item?.initialized || !item.version || !/^-?\d{1,13}$/.test(movementQuantity) || BigInt(movementQuantity) === 0n || (movementKind !== 'adjustment' && BigInt(movementQuantity) < 0n)) {
      setError('Elegí un producto con conteo y una cantidad entera válida.'); return
    }
    void execute({ name: 'inventory_adjust', args: { p_restaurant_id: restaurantId, p_operation_id: crypto.randomUUID(), p_kind: movementKind, p_rows: [{ productId, quantity: movementQuantity, expectedVersion: item.version }], p_reason: movementReason.trim(), ...(movementKind === 'external_sale' ? { p_external_reference: externalReference.trim() } : {}) } })
  }

  if (query.isLoading) return <LoadingScreen />
  if (query.error || !query.data) return <ErrorPanel>{query.error?.message ?? 'No se pudo cargar el inventario.'}</ErrorPanel>
  const { policy, items, operations } = query.data
  const disabled = busy || Boolean(pending)
  const modeLabel = countId ? 'Conteo en curso' : policy.mode === 'enforced' ? 'Activo' : policy.mode === 'paused' ? 'Pausado' : 'Sin activar'
  return <>
    <PageHeader eyebrow="Operación" title="Stock" description="Al aceptar se reserva mercadería. Al recibir el cliente o retirar, se descuenta la existencia." actions={<button className="button-secondary" disabled={busy} onClick={() => void query.refetch()}>Actualizar</button>} />
    <p className="mb-5 rounded-2xl border border-stone-200 bg-white p-4"><strong>{modeLabel}</strong>{policy.mode === 'paused' || countId ? ' · Las operaciones afectadas están pausadas; los movimientos y las reservas se conservan.' : null}</p>
    {error ? <p className="form-error mb-4" role="alert">{error}</p> : null}
    {message ? <p className="form-success mb-4" role="status">{message}</p> : null}
    {pending && isAdmin ? <section className="mb-5 rounded-2xl bg-amber-50 p-4"><p>Hay una operación pendiente de confirmación. Recuperá ese envío antes de registrar otro.</p><button className="button-primary mt-3" disabled={busy} onClick={() => void execute(pending)}>Reintentar operación</button></section> : null}
    {!policy.businessConfirmed && isAdmin ? <section className="form-card mb-5"><h2 className="form-card-title">Reglas para activar el stock</h2><p>Esta versión admite productos enteros, una presentación por producto y entregas y devoluciones completas. La app será la fuente principal del stock. Las reservas aceptadas se liberan al cancelar, sin vencimiento automático. El conteo incluye mercadería en tránsito pendiente de recepción o retiro.</p><p className="mt-3">Si necesitás cajas y unidades del mismo saldo, fracciones o entregas/devoluciones parciales, deben incorporarse antes de activar.</p><label className="field mt-4"><span>Ventas fuera de la app</span><select value={otherChannels} disabled={disabled} onChange={event => setOtherChannels(event.target.value as typeof otherChannels)}><option value="none">No hay otros canales</option><option value="record_before_handoff">Se registran aquí al entregar, antes de cerrar la venta</option></select></label><label className="check-field mt-4"><input type="checkbox" checked={businessAccepted} disabled={disabled} onChange={event => setBusinessAccepted(event.target.checked)} />Confirmo que estas reglas describen la operación del comercio.</label><button className="button-primary mt-4" disabled={disabled || !businessAccepted} onClick={() => void execute({ name: 'confirm_inventory_business_policy', args: { p_restaurant_id: restaurantId, p_policy: { unitModel: 'whole_product', sourceOfTruth: 'app', otherChannels, returns: 'full_only', acceptance: 'reserve', delivery: 'physical_handoff', partialDeliveries: 'none', physicalScope: 'until_handoff_including_transit', acceptedReservationsExpire: false } } })}>Guardar reglas</button></section> : null}
    {isAdmin && !countId ? <section className="form-card mb-5"><h2 className="form-card-title">{policy.mode === 'enforced' ? 'Pausar para contar o resolver una contingencia' : 'Conteo físico'}</h2><p>Para contar, detené movimientos físicos en todos los canales, incluidos ingresos y devoluciones. El sistema también pausará pedidos, aceptación y entregas hasta finalizar.</p><label className="field mt-4"><span>Motivo</span><input value={reason} maxLength={500} disabled={disabled} onChange={event => setReason(event.target.value)} /></label><div className="mt-4 flex flex-wrap gap-3">{policy.mode === 'enforced' ? <button className="button-secondary" disabled={disabled || reason.trim().length < 3} onClick={() => void execute({ name: 'change_inventory_policy', args: { p_restaurant_id: restaurantId, p_mode: 'paused', p_reason: reason.trim(), p_expected_policy_version: Number(policy.version) } })}>Pausar operaciones</button> : <button className="button-primary" disabled={disabled || reason.trim().length < 3} onClick={() => void execute({ name: 'begin_inventory_count', args: { p_restaurant_id: restaurantId, p_operation_id: crypto.randomUUID(), p_reason: reason.trim() } })}>Iniciar ventana de conteo</button>}{policy.mode === 'paused' ? <button className="button-secondary" disabled={disabled || reason.trim().length < 3} onClick={() => void execute({ name: 'change_inventory_policy', args: { p_restaurant_id: restaurantId, p_mode: 'enforced', p_reason: reason.trim(), p_expected_policy_version: Number(policy.version) } })}>Reanudar operaciones</button> : null}</div></section> : null}
    {countId ? <p className="mb-4 rounded-2xl bg-amber-50 p-4">Ventana iniciada: {new Date(policy.countStartedAt!).toLocaleString('es-AR')}. Registrá cada cantidad mientras contás. Si hubo movimientos físicos durante la ventana, detené el registro y conciliá antes de cerrar.</p> : null}
    <section className="form-card"><h2 className="form-card-title">Existencias · {items.length} productos</h2><p className="mb-4 text-sm">Incluye productos archivados con saldo registrado o pedidos pendientes; también deben contarse.</p><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Producto</th><th>Código / SKU</th><th>Existencia</th><th>Reservado</th><th>Disponible</th>{countId && isAdmin ? <th>Conteo físico</th> : null}</tr></thead><tbody>{items.map(item => <tr key={item.productId}><td>{item.name}{item.archived ? <span className="ml-2 text-xs text-stone-500">Archivado</span> : null}</td><td>{item.code}</td><td>{item.initialized ? item.onHand : 'Sin conteo'}</td><td>{item.reserved ?? '—'}</td><td>{item.available ?? '—'}</td>{countId && isAdmin ? <td><input className="w-28 rounded-lg border p-2" aria-label={`Conteo de ${item.name}`} inputMode="numeric" value={counts[item.productId]?.quantity ?? ''} disabled={disabled} onChange={event => updateCount(item.productId, event.target.value)} /></td> : null}</tr>)}</tbody></table></div></section>
    {countId && isAdmin ? <section className="form-card mt-5"><h2 className="form-card-title">Revisar y registrar conteo</h2><p>{Object.values(counts).filter(row => row.quantity !== '').length} cantidades cargadas. Revisá la tabla: cero es una cantidad explícita; un campo vacío sigue sin contar.</p><label className="field mt-4"><span>Observación del conteo</span><textarea maxLength={2000} value={note} disabled={disabled} onChange={event => setNote(event.target.value)} placeholder="Responsable, alcance contado y comprobación de todos los canales" /></label><label className="check-field mt-4"><input type="checkbox" checked={noMovements} disabled={disabled} onChange={event => setNoMovements(event.target.checked)} />Confirmo que no hubo movimientos físicos entre contar y registrar, en ningún canal.</label>{policy.mode === 'never_enabled' ? <><label className="check-field mt-4"><input type="checkbox" checked={activate} disabled={disabled || !policy.businessConfirmed} onChange={event => setActivate(event.target.checked)} />Activar el stock con este conteo.</label>{!policy.businessConfirmed ? <p className="mt-2 text-sm">Primero confirmá las reglas comerciales.</p> : null}{activate ? <div className="mt-4"><h3 className="font-bold">Pedidos pendientes que se incorporarán</h3><p className="text-sm">Revisá cada pedido. Los ya aceptados reservarán mercadería al activar; los demás reservarán al aceptarlos.</p>{openOrders.error ? <ErrorPanel>{openOrders.error.message}</ErrorPanel> : null}{openOrders.data?.map(order => <label className="check-field mt-2" key={order.id}><input type="checkbox" checked={reviewedOrders.includes(order.id)} disabled={disabled} onChange={event => setReviewedOrders(rows => event.target.checked ? [...rows, order.id] : rows.filter(id => id !== order.id))} /><Link to={`/admin/pedidos/${order.id}`}>{order.display_number}</Link> · {order.status === 'accepted' ? 'Aceptado: reservar' : 'Pendiente de aceptación'}</label>)}</div> : null}</> : <p className="mt-3 text-sm">Finalizar el conteo conserva la pausa. Reanudá cuando la contingencia esté resuelta.</p>}<button className="button-primary mt-4" disabled={disabled || !noMovements || note.trim().length < 10 || (activate && (openOrders.isLoading || Boolean(openOrders.error) || reviewedOrders.length !== openOrders.data?.length))} onClick={finishCount}>Registrar conteo{activate ? ' y activar stock' : ''}</button></section> : null}
    {isAdmin && policy.mode === 'enforced' && !countId ? <section className="form-card mt-5"><h2 className="form-card-title">Registrar movimiento</h2><div className="grid gap-4 sm:grid-cols-2"><label className="field"><span>Acción</span><select value={movementKind} disabled={disabled} onChange={event => setMovementKind(event.target.value as typeof movementKind)}><option value="receipt">Ingreso de mercadería</option><option value="adjustment">Merma o corrección de movimiento</option>{policy.businessPolicy?.otherChannels === 'record_before_handoff' ? <option value="external_sale">Venta fuera de la app</option> : null}</select></label><label className="field"><span>Producto</span><select value={productId} disabled={disabled} onChange={event => setProductId(event.target.value)}><option value="">Elegí un producto</option>{items.filter(item => item.initialized).map(item => <option key={item.productId} value={item.productId}>{item.name} · {item.code}</option>)}</select></label><label className="field"><span>{movementKind === 'adjustment' ? 'Cantidad a sumar o restar' : 'Cantidad'}</span><input inputMode="numeric" value={movementQuantity} disabled={disabled} onChange={event => setMovementQuantity(event.target.value)} /></label><label className="field"><span>Motivo del movimiento</span><input value={movementReason} maxLength={500} disabled={disabled} onChange={event => setMovementReason(event.target.value)} /></label>{movementKind === 'external_sale' ? <label className="field"><span>Canal y referencia de la venta</span><input value={externalReference} disabled={disabled} onChange={event => setExternalReference(event.target.value)} placeholder="Por ejemplo: mostrador, comprobante 123" /></label> : null}</div>{movementKind === 'adjustment' ? <p className="mt-3 text-sm">Indicá el cambio, no el saldo final. Para reemplazar existencias según un conteo, usá la ventana de conteo físico.</p> : null}<button className="button-primary mt-4" disabled={disabled || movementReason.trim().length < 3 || !productId || !movementQuantity || (movementKind === 'external_sale' && externalReference.trim().length < 3)} onClick={recordMovement}>Registrar movimiento</button></section> : null}
    <section className="form-card mt-5"><h2 className="form-card-title">Últimos {operations.length} movimientos</h2><p className="mb-4 text-sm">Se muestran hasta 100 operaciones. Las reservas afectan disponible; las entregas afectan existencia. Una devolución no confirma un reintegro de dinero.</p><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Fecha</th><th>Acción</th><th>Motivo y cantidades</th><th>Responsable</th><th>Pedido</th></tr></thead><tbody>{operations.map(operation => <tr key={operation.id}><td>{new Date(operation.createdAt).toLocaleString('es-AR')}</td><td>{operationLabels[operation.kind] ?? operation.kind}</td><td>{operation.reason}{operation.movements.length ? <details className="mt-2"><summary className="cursor-pointer">Ver cantidades</summary><ul className="mt-2 space-y-1">{operation.movements.map(movement => <li key={movement.productId}>{items.find(item => item.productId === movement.productId)?.name ?? 'Producto archivado'}: existencia {movement.deltaOnHand}, reserva {movement.deltaReserved}{movement.returnedQuantity !== '0' ? `, recibido en devolución ${movement.returnedQuantity}` : ''}. Saldo: {movement.onHandAfter}.</li>)}</ul></details> : null}</td><td>{operation.actorName || 'Operador registrado'}</td><td>{operation.orderId ? <Link to={`/admin/pedidos/${operation.orderId}`}>Ver pedido</Link> : '—'}</td></tr>)}</tbody></table></div></section>
  </>
}
