import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
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
      role: 'restaurant_admin',
    }],
    selected: {
      id: RESTAURANT_ID,
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: 'restaurant_admin',
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
    mocks.from.mockReset()
    mocks.rpc.mockReset()
    mocks.selectRestaurant.mockReset()
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
