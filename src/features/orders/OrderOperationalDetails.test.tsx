import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaimOrderPage } from './ClaimOrderPage'
import { OrderDetailPage } from './OrderDetailPage'

const RESTAURANT_ID = '10000000-0000-4000-8000-000000000001'
const ORDER_ID = '20000000-0000-4000-8000-000000000001'
const ACTION_ID = '30000000-0000-4000-8000-000000000001'
const PAYMENT_ID = '40000000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  selectRestaurant: vi.fn(),
  role: 'restaurant_admin' as 'restaurant_admin' | 'order_manager',
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
}))

vi.mock('../restaurants/RestaurantScope', () => ({
  useRestaurantScope: () => ({
    choices: [{
      id: RESTAURANT_ID,
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: mocks.role,
    }],
    selected: {
      id: RESTAURANT_ID,
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: mocks.role,
    },
    selectRestaurant: mocks.selectRestaurant,
  }),
}))

function wrapper(initialEntry: string, path: string, element: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes><Route path={path} element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const claimOrder = {
  id: ORDER_ID,
  restaurantId: RESTAURANT_ID,
  actionId: ACTION_ID,
  displayNumber: 'PED-0001',
  status: 'generated',
  customerName: 'Cliente Uno',
  customerPhone: '+5493492123456',
  fulfillmentType: 'delivery',
  deliveryAddress: 'Balbi 1173',
  deliveryCity: 'Rafaela',
  deliveryNeighborhood: 'Centro',
  deliveryFloor: '4',
  deliveryApartment: 'B',
  deliveryReference: 'Portón negro',
  customerNotes: 'Sin cubiertos',
  paymentMethodName: 'Transferencia',
  paymentInstructions: 'Enviar comprobante por WhatsApp',
  transferAlias: 'mozzi.test',
  subtotalCents: 120000,
  discountCents: 0,
  surchargeCents: 0,
  deliveryFeeCents: 0,
  totalCents: 120000,
  currencyCode: 'ARS',
  whatsappOpenedAt: null,
  acceptedBy: null,
  acceptedByName: null,
  acceptedAt: null,
  completedBy: null,
  completedByName: null,
  completedAt: null,
  cancelledBy: null,
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: null,
  expiresAt: null,
  createdAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
  items: [{
    id: '50000000-0000-4000-8000-000000000001',
    productId: null,
    code: 'P-1',
    name: 'Milanesa',
    quantity: 1,
    unitPriceCents: 120000,
    optionsTotalUnitCents: 0,
    lineTotalCents: 120000,
    notes: 'Bien cocida',
    options: [],
  }],
  events: [],
}

const adminOrder = {
  id: ORDER_ID,
  restaurant_id: RESTAURANT_ID,
  action_id: ACTION_ID,
  display_number: 'PED-0001',
  status: 'generated',
  customer_name: 'Cliente Uno',
  customer_phone: '+5493492123456',
  fulfillment_type: 'delivery',
  delivery_address: 'Balbi 1173',
  delivery_city: 'Rafaela',
  delivery_neighborhood: 'Centro',
  delivery_floor: '4',
  delivery_apartment: 'B',
  delivery_reference: 'Portón negro',
  customer_notes: 'Sin cubiertos',
  payment_method_id: PAYMENT_ID,
  payment_method_name_snapshot: 'Transferencia',
  payment_transfer_alias_snapshot: 'mozzi.test',
  payment_account_holder_snapshot: 'Mozzi SAS',
  payment_bank_name_snapshot: 'Banco Demo',
  payment_instructions_snapshot: 'Enviar comprobante por WhatsApp',
  subtotal_cents: 120000,
  discount_cents: 0,
  surcharge_cents: 0,
  delivery_fee_cents: 0,
  total_cents: 120000,
  currency_code: 'ARS',
  whatsapp_opened_at: null,
  accepted_by: null,
  accepted_at: null,
  completed_by: null,
  completed_at: null,
  cancelled_by: null,
  cancelled_at: null,
  cancel_reason: null,
  created_at: '2026-09-29T12:00:00.000Z',
  updated_at: '2026-09-29T12:00:00.000Z',
}

describe('operational order details', () => {
  afterEach(cleanup)

  beforeEach(() => {
    localStorage.clear()
    mocks.role = 'restaurant_admin'
    mocks.from.mockReset()
    mocks.rpc.mockReset()
    mocks.selectRestaurant.mockReset()
  })

  it('renders the frozen variant attributes without changing the historical item title', async () => {
    setupInventoryOrder('completed', { product_name_snapshot: 'Nombre histórico del pedido', family_name_snapshot: 'Familia original', variant_attributes_snapshot: { Modelo: 'iPhone 15', Color: 'Rojo original' } })
    mocks.rpc.mockResolvedValue({ data: inventoryDetail, error: null })
    wrapper(`/admin/pedidos/${ORDER_ID}`, '/admin/pedidos/:orderId', <OrderDetailPage />)
    expect(await screen.findByText('3 × Nombre histórico del pedido')).toBeVisible()
    expect(screen.getByLabelText('Variante elegida')).toHaveTextContent('Modelo: iPhone 15 · Color: Rojo original')
    expect(mocks.from.mock.calls.some(([table]) => table === 'products' || table === 'product_families')).toBe(false)
  })

  it('acceptance reserves explicitly and blocks duplicate clicks while a response is pending', async () => {
    let finish: ((value: unknown) => void) | undefined
    mocks.rpc.mockImplementation((name: string) => name === 'claim_order'
      ? new Promise((resolve) => { finish = resolve })
      : Promise.resolve({ data: { ...claimOrder, inventoryTracked: true }, error: null }))
    wrapper(`/admin/tomar/${ACTION_ID}`, '/admin/tomar/:actionId', <ClaimOrderPage />)
    const button = await screen.findByRole('button', { name: 'Aceptar y reservar' })
    expect(screen.getByText(/La existencia física se descuenta cuando confirmes la recepción/)).toBeVisible()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'claim_order')).toHaveLength(1)
    finish?.({ data: { claimed: true, alreadyClaimed: false }, error: null })
    expect(await screen.findByRole('status')).toHaveTextContent('todavía no se descontó la existencia física')
  })

  it('shows insufficient-stock failures without exposing database messages', async () => {
    mocks.rpc.mockImplementation((name: string) => Promise.resolve(name === 'claim_order'
      ? { data: null, error: { message: 'INSUFFICIENT_STOCK private inventory balances' } }
      : { data: { ...claimOrder, inventoryTracked: true }, error: null }))
    wrapper(`/admin/tomar/${ACTION_ID}`, '/admin/tomar/:actionId', <ClaimOrderPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar y reservar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No hay stock disponible suficiente')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private')
  })

  it('requires physical receipt confirmation and sends one delivery on double click', async () => {
    const order = setupInventoryOrder('accepted')
    let finish: ((value: unknown) => void) | undefined
    mocks.rpc.mockImplementation((name: string) => name === 'complete_order'
      ? new Promise((resolve) => { finish = resolve })
      : Promise.resolve({ data: inventoryDetail, error: null }))
    wrapper(`/admin/pedidos/${ORDER_ID}`, '/admin/pedidos/:orderId', <OrderDetailPage />)
    const button = await screen.findByRole('button', { name: 'Confirmar recepción' })
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Confirmo que el cliente recibió todo el pedido.'))
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'complete_order')).toHaveLength(1)
    order.status = 'completed'
    order.inventory_outcome = 'delivered'
    finish?.({ data: { alreadyDelivered: false }, error: null })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirmar recepción' })).not.toBeInTheDocument())
  })

  it('retries a complete return with the same operation and explicit sellable quantities', async () => {
    const user = userEvent.setup()
    const order = setupInventoryOrder('completed')
    let attempts = 0
    mocks.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name !== 'reverse_order_inventory') return Promise.resolve({ data: inventoryDetail, error: null })
      attempts += 1
      if (attempts === 1) return Promise.resolve({ data: null, error: { message: 'connection lost' } })
      order.inventory_outcome = 'returned'
      return Promise.resolve({ data: { operationId: args.p_operation_id, orderId: ORDER_ID }, error: null })
    })
    wrapper(`/admin/pedidos/${ORDER_ID}`, '/admin/pedidos/:orderId', <OrderDetailPage />)
    await screen.findByRole('heading', { name: 'Devolución o corrección completa' })
    await user.type(screen.getByLabelText('Motivo'), 'Envase dañado')
    await user.selectOptions(screen.getByLabelText('Mercadería que queda vendible'), 'partial')
    await user.type(screen.getByLabelText('Producto de prueba · recibidas 3'), '1')
    await user.click(screen.getByLabelText('Confirmo que se recibió la devolución completa y revisé la cantidad vendible.'))
    await user.click(screen.getByRole('button', { name: 'Registrar devolución completa' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar la operación')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar misma operación' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Reintentar misma operación' }))
    const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'reverse_order_inventory')
    expect(calls).toHaveLength(2)
    expect(calls[1]![1]).toEqual(calls[0]![1])
    expect(calls[0]![1]).toMatchObject({ p_kind: 'return', p_restock: true, p_restock_quantities: [{ productId: PRODUCT_ID, quantity: 1 }] })
    expect(await screen.findByText(/Su importe no se suma como venta vigente/)).toBeVisible()
  })

  it.each(['2', 2])('opens the returned order and its history when the RPC preserves quantity %j', async quantity => {
    const order = setupInventoryOrder('completed')
    order.inventory_outcome = 'returned'
    mocks.rpc.mockResolvedValue({ data: {
      replacementOrderId: null,
      inventoryOperations: [{
        id: '70000000-0000-4000-8000-000000000001', kind: 'return', reason: 'Devolución total, una unidad dañada',
        createdAt: '2026-10-24T12:00:00Z', actorUserId: RESTAURANT_ID,
        result: { restocked: true, restockQuantities: [{ productId: PRODUCT_ID, quantity }] },
      }],
    }, error: null })
    wrapper(`/admin/pedidos/${ORDER_ID}`, '/admin/pedidos/:orderId', <OrderDetailPage />)
    expect(await screen.findByRole('heading', { name: 'PED-0001' })).toBeVisible()
    expect(screen.getByText('Producto de prueba: 2 unidades repuestas como vendibles.')).toBeVisible()
    expect(screen.getByText('Devolución total, una unidad dañada')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mocks.rpc).toHaveBeenCalledWith('get_order_by_action', { p_action_id: ACTION_ID })
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'get_order_by_action')).toBe(true)
  })

  it('does not expose administrator reversals to an order manager', async () => {
    mocks.role = 'order_manager'
    setupInventoryOrder('completed')
    mocks.rpc.mockResolvedValue({ data: inventoryDetail, error: null })
    wrapper(`/admin/pedidos/${ORDER_ID}`, '/admin/pedidos/:orderId', <OrderDetailPage />)
    await screen.findByRole('heading', { name: 'Entrega e inventario' })
    expect(screen.queryByRole('heading', { name: 'Devolución o corrección completa' })).not.toBeInTheDocument()
  })

  it('shows every operational field on the claim screen', async () => {
    mocks.rpc.mockResolvedValue({ data: claimOrder, error: null })
    wrapper(`/admin/tomar/${ACTION_ID}`, '/admin/tomar/:actionId', <ClaimOrderPage />)

    expect(await screen.findByRole('heading', { name: 'PED-0001' })).toBeVisible()
    expect(screen.getByRole('link', { name: '+5493492123456' })).toHaveAttribute('href', 'tel:+5493492123456')
    expect(screen.getByText(/Piso 4/)).toBeVisible()
    expect(screen.getByText(/Depto B/)).toBeVisible()
    expect(screen.getByText(/Portón negro/)).toBeVisible()
    expect(screen.getByText(/Sin cubiertos/)).toBeVisible()
    expect(screen.getByText(/mozzi.test/)).toBeVisible()
    expect(screen.getByText(/Enviar comprobante por WhatsApp/)).toBeVisible()
    expect(screen.getByText(/Bien cocida/)).toBeVisible()
  })

  it('shows address-unit, notes and transfer snapshots on the full detail screen', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ single: async () => ({ data: adminOrder, error: null }) }),
            }),
          }),
        }
      }
      if (table === 'order_items' || table === 'order_events') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ order: async () => ({ data: [], error: null }) }),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    })
    wrapper(`/admin/pedidos/${ORDER_ID}`, '/admin/pedidos/:orderId', <OrderDetailPage />)

    expect(await screen.findByRole('heading', { name: 'Cliente y entrega' })).toBeVisible()
    for (const value of [
      '+5493492123456',
      'Balbi 1173, Centro, Rafaela',
      '4',
      'B',
      'Portón negro',
      'Sin cubiertos',
      'mozzi.test',
      'Mozzi SAS',
      'Banco Demo',
      'Enviar comprobante por WhatsApp',
    ]) {
      expect(screen.getByText(value)).toBeVisible()
    }
  })
})

const PRODUCT_ID = '60000000-0000-4000-8000-000000000001'
const inventoryDetail = { replacementOrderId: null, inventoryOperations: [] }
function setupInventoryOrder(status: string, itemOverrides: Record<string, unknown> = {}) {
  const order = { ...adminOrder, status, inventory_tracked: true, inventory_outcome: status === 'completed' ? 'delivered' : 'none' }
  mocks.from.mockImplementation((table: string) => {
    const rows = table === 'order_items' ? [{
      id: '50000000-0000-4000-8000-000000000001', order_id: ORDER_ID, product_id: PRODUCT_ID,
      product_name_snapshot: 'Producto de prueba', product_code_snapshot: 'P-1', quantity: 3,
      unit_price_cents: 100, base_subtotal_cents: 300, pricing_mode_snapshot: 'unit', pricing_breakdown_snapshot: { mode: 'unit', unitPriceCents: 100, baseSubtotalCents: 300, components: [] }, options_total_unit_cents: 0, line_total_cents: 300, notes: null,
      ...itemOverrides,
    }] : []
    const request: Record<string, unknown> & PromiseLike<unknown> = { then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject) }, single: () => Promise.resolve({ data: order, error: null }) }
    for (const method of ['select', 'eq', 'order', 'in', 'is', 'limit', 'ilike']) request[method] = () => request
    return request
  })
  return order
}
