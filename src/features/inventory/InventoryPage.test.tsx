import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { InventoryPage } from './InventoryPage'

const tenant = '10000000-0000-4000-8000-000000000001'
const product = '20000000-0000-4000-8000-000000000001'
const count = '30000000-0000-4000-8000-000000000001'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), mutate: vi.fn(), role: 'restaurant_admin', inventory: {} as Record<string, unknown> }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: '10000000-0000-4000-8000-000000000001', role: mocks.role } }) }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: () => ({ select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }) } }))
function view() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><InventoryPage /></MemoryRouter></QueryClientProvider>)
}
function fixture(mode = 'enforced', countId: string | null = null) {
  return {
    policy: { mode, version: '1', activatedAt: mode === 'never_enabled' ? null : '2026-10-24T12:00:00Z', pausedAt: null, cutoverId: countId, countStartedAt: countId ? new Date().toISOString() : null, businessConfirmed: true, businessPolicy: { otherChannels: 'none' } },
    items: [{ productId: product, code: '0001', name: 'Arroz', initialized: true, onHand: '5', reserved: '2', available: '3', version: '1' }], nextCursor: null, operations: [],
  }
}
describe('inventory operation UI (backend contracts simulated)', () => {
  afterEach(cleanup)
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear(); mocks.role = 'restaurant_admin'
    mocks.inventory = fixture(); mocks.mutate.mockReset().mockResolvedValue({ data: {}, error: null })
    mocks.rpc.mockReset().mockImplementation(async (name, args) => name === 'get_inventory' ? { data: structuredClone(mocks.inventory), error: null } : mocks.mutate(name, args))
  })
  it('gives an order manager stock visibility without mutation controls', async () => {
    mocks.role = 'order_manager'; view()
    expect(await screen.findByText('Arroz')).toBeVisible()
    expect(screen.getByText('0001')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Pausar operaciones' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Registrar movimiento' })).not.toBeInTheDocument()
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
})
