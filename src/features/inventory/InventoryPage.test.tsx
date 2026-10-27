import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { InventoryPage } from './InventoryPage'

const tenant = '10000000-0000-4000-8000-000000000001'
const product = '20000000-0000-4000-8000-000000000001'
const secondProduct = '20000000-0000-4000-8000-000000000002'
const count = '30000000-0000-4000-8000-000000000001'
const externalOperation = '40000000-0000-4000-8000-000000000001'
const receiptOperation = '40000000-0000-4000-8000-000000000002'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), mutate: vi.fn(), from: vi.fn(), references: vi.fn(), role: 'restaurant_admin', inventory: {} as Record<string, unknown> }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: '10000000-0000-4000-8000-000000000001', role: mocks.role } }) }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }))
function view() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><InventoryPage /></MemoryRouter></QueryClientProvider>)
}
function fixture(mode = 'enforced', countId: string | null = null) {
  return {
    policy: { mode, version: '1', activatedAt: mode === 'never_enabled' ? null : '2026-10-24T12:00:00Z', pausedAt: null, cutoverId: countId, countStartedAt: countId ? new Date().toISOString() : null, businessConfirmed: true, businessPolicy: { otherChannels: 'none' } },
    items: [{ productId: product, code: '0001', name: 'Arroz', initialized: true, onHand: '5', reserved: '2', available: '3', version: '1' }], nextCursor: null, operations: [],
  }
}
function externalSaleFixture() {
  const data = fixture()
  data.policy.businessPolicy.otherChannels = 'record_before_handoff'
  data.items.push({ productId: secondProduct, code: '0002', name: 'Fideos', initialized: true, onHand: '10', reserved: '0', available: '10', version: '7' })
  return data
}
function historyFixture() {
  const operation = { id: externalOperation, kind: 'external_sale', orderId: null, sourceOperationId: null, reason: 'Venta fuera de la app', actorUserId: tenant, actorName: 'Operador', createdAt: '2026-10-24T12:00:00Z', result: {}, movements: [] }
  return { ...externalSaleFixture(), operations: [operation, { ...operation, id: receiptOperation, kind: 'receipt', reason: 'Ingreso de proveedor' }] }
}
async function fillExternalSale(user: ReturnType<typeof userEvent.setup>, note = 'Entrega completa en mostrador') {
  await screen.findByText('Arroz')
  await user.selectOptions(screen.getByLabelText('Acción'), 'external_sale')
  await user.type(screen.getByLabelText('Canal y referencia de la venta'), 'Mostrador 123')
  if (note) await user.type(screen.getByLabelText('Nota (opcional)'), note)
  await user.selectOptions(screen.getByLabelText('Producto 1'), product)
  await user.type(screen.getByLabelText('Cantidad 1'), '2')
  await user.click(screen.getByRole('button', { name: 'Agregar producto' }))
  await user.selectOptions(screen.getByLabelText('Producto 2'), secondProduct)
  await user.type(screen.getByLabelText('Cantidad 2'), '4')
}
describe('inventory operation UI (backend contracts simulated)', () => {
  afterEach(cleanup)
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear(); mocks.role = 'restaurant_admin'
    mocks.inventory = fixture(); mocks.mutate.mockReset().mockResolvedValue({ data: {}, error: null })
    mocks.rpc.mockReset().mockImplementation(async (name, args) => name === 'get_inventory' ? { data: structuredClone(mocks.inventory), error: null } : mocks.mutate(name, args))
    mocks.references.mockReset().mockResolvedValue({ data: [{ id: externalOperation, external_reference: 'Mostrador, comprobante 123' }], error: null })
    mocks.from.mockReset().mockImplementation(table => table === 'inventory_operations'
      ? { select: (columns: string) => ({ eq: (tenantColumn: string, tenantId: string) => ({ in: (idColumn: string, ids: string[]) => mocks.references({ columns, tenantColumn, tenantId, idColumn, ids }) }) }) }
      : { select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) })
  })
  it('gives an order manager stock visibility without mutation controls', async () => {
    mocks.role = 'order_manager'; view()
    expect(await screen.findByText('Arroz')).toBeVisible()
    expect(screen.getByText('0001')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Pausar operaciones' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Registrar movimiento' })).not.toBeInTheDocument()
    expect(mocks.references).not.toHaveBeenCalled()
  })
  it('shows automated payment holds without requiring a human actor', async () => {
    mocks.inventory = { ...fixture(), operations: [{ id: externalOperation, kind: 'payment_hold', orderId: null, sourceOperationId: null, reason: 'Mercado Pago: payment_hold', actorUserId: null, actorName: null, createdAt: '2026-10-27T12:00:00Z', result: {}, movements: [] }] }
    view()
    expect(await screen.findByText('Reserva temporal de pago')).toBeVisible()
    expect(screen.getByText('Sistema de pagos')).toBeVisible()
    expect(screen.getByText('Arroz')).toBeVisible()
  })
  it('shows the external-sale reference separately from its default reason using a tenant-scoped bounded read', async () => {
    mocks.inventory = historyFixture(); mocks.role = 'order_manager'; view()
    expect(await screen.findByText('Mostrador, comprobante 123')).toBeVisible()
    expect(screen.getByText('Venta fuera de la app')).toBeVisible()
    expect(screen.getByText('Ingreso de proveedor')).toBeVisible()
    expect(mocks.from).toHaveBeenCalledWith('inventory_operations')
    expect(mocks.references).toHaveBeenCalledTimes(1)
    expect(mocks.references).toHaveBeenCalledWith({ columns: 'id,external_reference', tenantColumn: 'restaurant_id', tenantId: tenant, idColumn: 'id', ids: [externalOperation] })
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
  it.each(['query-error', 'missing-row', 'invalid-reference', 'network-error'])('does not show incomplete external-sale history when reference loading fails: %s', async failure => {
    mocks.inventory = historyFixture()
    if (failure === 'network-error') mocks.references.mockRejectedValueOnce(new Error('Network unavailable'))
    else mocks.references.mockResolvedValueOnce(failure === 'query-error'
      ? { data: null, error: { message: 'Permission denied' } }
      : { data: failure === 'missing-row' ? [] : [{ id: externalOperation, external_reference: null }], error: null })
    const user = userEvent.setup(); view()
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar las referencias de las ventas externas')
    expect(screen.queryByRole('heading', { name: /Últimos .* movimientos/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reintentar carga' }))
    expect(await screen.findByText('Mostrador, comprobante 123')).toBeVisible()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
  it('keeps archived stock visible and mandatory in a physical recount', async () => {
    const data = fixture('paused', count)
    mocks.inventory = { ...data, items: data.items.map(item => ({ ...item, archived: true })) }
    const user = userEvent.setup(); view()
    expect(await screen.findByText('Archivado')).toBeVisible()
    await user.type(screen.getByLabelText('Observación del conteo'), 'Conteo incluye existencias archivadas')
    await user.click(screen.getByRole('checkbox', { name: /no hubo movimientos físicos/ }))
    await user.click(screen.getByRole('button', { name: 'Registrar conteo' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('todos los productos')
    expect(mocks.mutate).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Conteo de Arroz'), '4')
    await user.click(screen.getByRole('button', { name: 'Registrar conteo' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('finish_inventory_count', expect.objectContaining({ p_rows: [expect.objectContaining({ productId: product, quantity: '4' })] })))
  })
  it('retains an uncertain operation and retries the same payload and UUID', async () => {
    const user = userEvent.setup(); mocks.mutate.mockRejectedValueOnce(new Error('Lost response'))
    view(); await screen.findByText('Arroz')
    await user.selectOptions(screen.getByLabelText('Producto'), product)
    await user.type(screen.getByLabelText('Cantidad'), '3')
    await user.type(screen.getByLabelText('Motivo del movimiento'), 'Ingreso proveedor')
    await user.click(screen.getByRole('button', { name: 'Registrar movimiento' }))
    const retry = await screen.findByRole('button', { name: 'Reintentar operación' })
    const original = structuredClone(mocks.mutate.mock.calls[0])
    expect(screen.getByLabelText('Cantidad')).toBeDisabled()
    await user.click(retry)
    await screen.findByText('Operación registrada.')
    expect(mocks.mutate.mock.calls[1]).toEqual(original)
    expect(sessionStorage.getItem(`mozzi:inventory-command:${tenant}`)).toBeNull()
  })
  it('records all products of an external sale once without a note, with one reference and each reviewed version', async () => {
    mocks.inventory = externalSaleFixture()
    let finish!: (result: { data: object; error: null }) => void
    mocks.mutate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const user = userEvent.setup(); view(); await fillExternalSale(user, '')
    await user.dblClick(screen.getByRole('button', { name: 'Registrar venta externa' }))
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(mocks.mutate).toHaveBeenCalledWith('inventory_adjust', {
      p_restaurant_id: tenant, p_operation_id: expect.any(String), p_kind: 'external_sale',
      p_external_reference: 'Mostrador 123', p_reason: 'Venta fuera de la app',
      p_rows: [
        { productId: product, quantity: '2', expectedVersion: '1' },
        { productId: secondProduct, quantity: '4', expectedVersion: '7' },
      ],
    })
    expect(screen.getByLabelText('Cantidad 2')).toBeDisabled()
    finish({ data: {}, error: null })
    await screen.findByText('Operación registrada.')
    expect(screen.getByLabelText('Producto 1')).toHaveValue('')
    expect(screen.queryByLabelText('Producto 2')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Canal y referencia de la venta')).toHaveValue('')
  })
  it.each(['a', 'ab'])('explains a too-short optional note (%s) without submitting the sale', async note => {
    mocks.inventory = externalSaleFixture()
    const user = userEvent.setup(); view(); await fillExternalSale(user, note)
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('La nota es opcional; si la escribís, usá al menos 3 caracteres.')
    expect(mocks.mutate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Nota (opcional)')).toHaveValue(note)
  })
  it('recovers an uncertain whole sale after reload and retries its original versions, reference and UUID', async () => {
    mocks.inventory = externalSaleFixture()
    mocks.mutate.mockRejectedValueOnce(new Error('Lost response'))
    const user = userEvent.setup(); const firstView = view(); await fillExternalSale(user)
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    await screen.findByRole('alert')
    const original = structuredClone(mocks.mutate.mock.calls[0])
    firstView.unmount()
    const updated = externalSaleFixture(); updated.items[0]!.version = '2'; updated.items[1]!.version = '8'; mocks.inventory = updated
    view()
    const retry = await screen.findByRole('button', { name: 'Reintentar operación' })
    expect(screen.getByLabelText('Canal y referencia de la venta')).toHaveValue('Mostrador 123')
    expect(screen.getByLabelText('Cantidad 1')).toHaveValue('2')
    expect(screen.getByLabelText('Cantidad 2')).toHaveValue('4')
    expect(screen.getByLabelText('Producto 1')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Agregar producto' })).toBeDisabled()
    await user.click(retry)
    await screen.findByText('Operación registrada.')
    expect(mocks.mutate).toHaveBeenCalledTimes(2)
    expect(mocks.mutate.mock.calls[1]).toEqual(original)
    expect(sessionStorage.getItem(`mozzi:inventory-command:${tenant}`)).toBeNull()
  })
  it.each(['1.5', '1,5', '-1', '0', '1e2', '10000000000000'])('rejects external-sale quantity %s without rounding or sending any row', async quantity => {
    mocks.inventory = externalSaleFixture()
    const user = userEvent.setup(); view(); await fillExternalSale(user)
    await user.clear(screen.getByLabelText('Cantidad 2'))
    expect(screen.getByRole('button', { name: 'Registrar venta externa' })).toBeDisabled()
    await user.type(screen.getByLabelText('Cantidad 2'), quantity)
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('cantidad entera mayor que cero en cada fila')
    expect(mocks.mutate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Cantidad 2')).toHaveValue(quantity)
    expect(screen.getByLabelText('Cantidad 1')).toHaveValue('2')
  })
  it('prevents duplicate products, requires every row and allows removing a row without changing the other', async () => {
    mocks.inventory = externalSaleFixture()
    const user = userEvent.setup(); view(); await fillExternalSale(user)
    expect(within(screen.getByLabelText('Producto 2')).getByRole('option', { name: 'Arroz · 0001' })).toBeDisabled()
    expect(within(screen.getByLabelText('Producto 1')).getByRole('option', { name: 'Fideos · 0002' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Producto 2'), '')
    expect(screen.getByRole('button', { name: 'Registrar venta externa' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Quitar producto 2' }))
    expect(screen.getByLabelText('Cantidad 1')).toHaveValue('2')
    expect(screen.getByRole('button', { name: 'Registrar venta externa' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    await screen.findByText('Operación registrada.')
    expect(mocks.mutate.mock.calls[0]![1].p_rows).toEqual([{ productId: product, quantity: '2', expectedVersion: '1' }])
  })
  it.each([
    ['INSUFFICIENT_STOCK', 'No alcanza el stock disponible'],
    ['INVENTORY_EXTERNAL_REFERENCE_DUPLICATE', 'Esa venta externa ya fue registrada'],
  ])('keeps the full sale editable after confirmed rollback: %s', async (message, description) => {
    mocks.inventory = externalSaleFixture()
    mocks.mutate.mockResolvedValueOnce({ data: null, error: { code: '22023', message } })
    const user = userEvent.setup(); view(); await fillExternalSale(user)
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(description)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(mocks.mutate.mock.calls[0]![1].p_rows).toHaveLength(2)
    expect(screen.getByLabelText('Cantidad 1')).toHaveValue('2')
    expect(screen.getByLabelText('Cantidad 2')).toHaveValue('4')
    expect(screen.getByLabelText('Canal y referencia de la venta')).toHaveValue('Mostrador 123')
    expect(screen.getByRole('button', { name: 'Registrar venta externa' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Reintentar operación' })).not.toBeInTheDocument()
    expect(sessionStorage.getItem(`mozzi:inventory-command:${tenant}`)).toBeNull()
  })
  it('refreshes all sale versions after a conflict and sends a new whole operation only on operator retry', async () => {
    mocks.inventory = externalSaleFixture()
    mocks.mutate.mockImplementationOnce(async () => {
      const updated = externalSaleFixture(); updated.items[0]!.version = '2'; updated.items[1]!.version = '8'; mocks.inventory = updated
      return { data: null, error: { code: '40001', message: 'INVENTORY_VERSION_CONFLICT' } }
    })
    const user = userEvent.setup(); view(); await fillExternalSale(user)
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('El saldo o el estado del inventario cambió')
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Registrar venta externa' }))
    await screen.findByText('Operación registrada.')
    expect(mocks.mutate.mock.calls[1]![1].p_rows).toEqual([
      { productId: product, quantity: '2', expectedVersion: '2' },
      { productId: secondProduct, quantity: '4', expectedVersion: '8' },
    ])
    expect(mocks.mutate.mock.calls[1]![1].p_operation_id).not.toBe(mocks.mutate.mock.calls[0]![1].p_operation_id)
  })
  it('keeps signed single-product adjustments independent of the external-sale rows', async () => {
    mocks.inventory = externalSaleFixture()
    const user = userEvent.setup(); view(); await fillExternalSale(user)
    await user.selectOptions(screen.getByLabelText('Acción'), 'adjustment')
    await user.selectOptions(screen.getByLabelText('Producto'), secondProduct)
    await user.type(screen.getByLabelText('Cantidad a sumar o restar'), '-1')
    await user.click(screen.getByRole('button', { name: 'Registrar movimiento' }))
    await screen.findByText('Operación registrada.')
    expect(mocks.mutate.mock.calls[0]![1]).toEqual({
      p_restaurant_id: tenant, p_operation_id: expect.any(String), p_kind: 'adjustment',
      p_reason: 'Entrega completa en mostrador', p_rows: [{ productId: secondProduct, quantity: '-1', expectedVersion: '7' }],
    })
  })
  it('does not treat an empty physical count as zero and requires the closed window evidence', async () => {
    mocks.inventory = fixture('paused', count)
    const user = userEvent.setup(); view(); await screen.findByLabelText('Conteo de Arroz')
    const finish = screen.getByRole('button', { name: 'Registrar conteo' })
    expect(finish).toBeDisabled()
    await user.type(screen.getByLabelText('Observación del conteo'), 'Operador verificó todos los canales cerrados')
    await user.click(screen.getByRole('checkbox', { name: /no hubo movimientos físicos/ }))
    await user.click(finish)
    expect(await screen.findByRole('alert')).toHaveTextContent('todos los productos')
    expect(mocks.mutate).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Conteo de Arroz'), '0')
    await user.click(finish)
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('finish_inventory_count', expect.objectContaining({ p_count_id: count, p_activate: false, p_no_movements_confirmed: true, p_rows: [expect.objectContaining({ productId: product, quantity: '0', countedAt: expect.any(String) })] })))
  })
  it('reloads a rejected stale version and lets the operator review a new attempt', async () => {
    const user = userEvent.setup()
    mocks.mutate.mockImplementationOnce(async () => {
      const updated = fixture(); updated.items[0]!.version = '2'; mocks.inventory = updated
      return { data: null, error: { code: '40001', message: 'INVENTORY_VERSION_CONFLICT' } }
    })
    view(); await screen.findByText('Arroz')
    await user.selectOptions(screen.getByLabelText('Producto'), product)
    await user.type(screen.getByLabelText('Cantidad'), '1')
    await user.type(screen.getByLabelText('Motivo del movimiento'), 'Ingreso nuevo')
    await user.click(screen.getByRole('button', { name: 'Registrar movimiento' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('El saldo o el estado del inventario cambió')
    expect(screen.queryByRole('button', { name: 'Reintentar operación' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Registrar movimiento' }))
    expect(mocks.mutate.mock.calls[1]![1].p_rows[0].expectedVersion).toBe('2')
    expect(mocks.mutate.mock.calls[1]![1].p_operation_id).not.toBe(mocks.mutate.mock.calls[0]![1].p_operation_id)
  })
  it('never confirms business rules or activates stock on load', async () => {
    const data = fixture('never_enabled'); data.policy.businessConfirmed = false; mocks.inventory = data
    view(); await screen.findByText('Reglas para activar el stock')
    expect(screen.getByRole('button', { name: 'Activar control de stock' })).toBeEnabled()
    await userEvent.click(screen.getByText('Herramientas avanzadas de inventario'))
    expect(screen.getByRole('button', { name: 'Guardar reglas' })).toBeDisabled()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
  it('does not let an old pause retry change a newer policy', async () => {
    const user = userEvent.setup()
    mocks.mutate.mockRejectedValueOnce(new Error('Lost response')).mockImplementationOnce(async () => {
      const latest = fixture(); latest.policy.version = '3'; mocks.inventory = latest
      return { data: null, error: { code: '40001', message: 'INVENTORY_VERSION_CONFLICT' } }
    })
    view(); await screen.findByText('Arroz')
    await user.click(screen.getByText('Herramientas avanzadas de inventario'))
    await user.type(screen.getByLabelText('Motivo'), 'Verificación física')
    await user.click(screen.getByRole('button', { name: 'Pausar operaciones' }))
    const first = structuredClone(mocks.mutate.mock.calls[0]!)
    expect(first[1].p_expected_policy_version).toBe(1)
    await user.click(await screen.findByRole('button', { name: 'Reintentar operación' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('estado del inventario cambió')
    expect(mocks.mutate.mock.calls[1]).toEqual(first)
    expect(screen.queryByRole('button', { name: 'Reintentar operación' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pausar operaciones' }))
    expect(mocks.mutate.mock.calls[2]![1].p_expected_policy_version).toBe(3)
  })
  it('explains why a paused inventory needs a count before resuming', async () => {
    mocks.inventory = fixture('paused')
    mocks.mutate.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'INVENTORY_RECONCILIATION_REQUIRED' } })
    const user = userEvent.setup(); view(); await screen.findByText('Arroz')
    await user.type(screen.getByLabelText('Motivo'), 'Revisar pausa')
    await user.click(screen.getByRole('button', { name: 'Reanudar operaciones' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Completá un conteo desde esta pausa')
    expect(screen.getByRole('button', { name: 'Iniciar ventana de conteo' })).toBeEnabled()
  })
  it('activates from explicit product balances with no physical count command and preserves an uncertain retry', async () => {
    const data = fixture('never_enabled'); data.policy.businessConfirmed = false; mocks.inventory = data
    mocks.mutate.mockRejectedValueOnce(new Error('Lost response'))
    const user = userEvent.setup(); const firstView = view()
    await user.click(await screen.findByRole('button', { name: 'Activar control de stock' }))
    await screen.findByRole('alert')
    const original = structuredClone(mocks.mutate.mock.calls[0])
    expect(original).toEqual(['activate_inventory_from_product_stock', { p_restaurant_id: tenant, p_operation_id: expect.any(String), p_expected_policy_version: 1, p_other_channels: 'none' }])
    firstView.unmount(); view()
    await user.click(await screen.findByRole('button', { name: 'Reintentar operación' }))
    await screen.findByText('Control de stock activado. Ya se limita la venta a las unidades disponibles.')
    expect(mocks.mutate.mock.calls[1]).toEqual(original)
    expect(sessionStorage.getItem(`mozzi:inventory-command:${tenant}`)).toBeNull()
  })
  it('requires a quantity for every product and links to its editor instead of starting a count', async () => {
    const data = fixture('never_enabled')
    mocks.inventory = { ...data, items: data.items.map(item => ({ ...item, initialized: false, onHand: null, reserved: null, available: null, version: null })) }
    view()
    expect(await screen.findByText('Falta cargar stock en 1 producto:')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Activar control de stock' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Editar stock de Arroz' })).toHaveAttribute('href', `/admin/catalogo/productos/${product}`)
    expect(screen.getByText('Sin cargar')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Iniciar ventana de conteo' })).not.toBeVisible()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
})
