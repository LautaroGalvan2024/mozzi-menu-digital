import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrdersPage, orderDateRangeError } from './OrdersPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  removeChannel: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    channel: () => ({
      on() { return this },
      subscribe() { return this },
    }),
    removeChannel: mocks.removeChannel,
  },
}))

vi.mock('../restaurants/RestaurantScope', () => ({
  useRestaurantScope: () => ({
    selected: {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: 'restaurant_admin',
    },
  }),
}))

vi.mock('../restaurants/useRestaurant', () => ({
  useRestaurant: () => ({
    data: { timezone: 'America/Argentina/Cordoba' },
    error: null,
    isLoading: false,
  }),
}))

function emptyOrdersRequest(data: unknown[] = []) {
  const request: Record<string, unknown> & PromiseLike<{ data: unknown[]; error: null; count: number }> = {
    then(resolve, reject) {
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject)
    },
  }
  for (const method of ['select', 'eq', 'gte', 'lt', 'order', 'range', 'ilike']) {
    request[method] = () => request
  }
  return request
}

const order = {
  id: '20000000-0000-4000-8000-000000000001', restaurant_id: '10000000-0000-4000-8000-000000000001',
  action_id: '30000000-0000-4000-8000-000000000001', display_number: 'PED-0001', status: 'generated',
  channel: 'store', checkout_mode: 'online', payment_status: 'approved', customer_name: 'Lucía', customer_phone: '+5493492123456',
  fulfillment_type: 'pickup', delivery_address: null, delivery_city: null, delivery_neighborhood: null,
  delivery_floor: null, delivery_apartment: null, delivery_reference: null, customer_notes: null,
  payment_method_id: '40000000-0000-4000-8000-000000000001', payment_method_name_snapshot: 'Mercado Pago',
  payment_transfer_alias_snapshot: null, payment_account_holder_snapshot: null, payment_bank_name_snapshot: null, payment_instructions_snapshot: null,
  subtotal_cents: 10000, discount_cents: 0, surcharge_cents: 0, delivery_fee_cents: 0, total_cents: 10000, currency_code: 'ARS',
  whatsapp_opened_at: null, accepted_by: null, accepted_at: null, completed_at: null, cancelled_at: null, cancel_reason: null,
  created_at: '2026-10-27T12:00:00.000Z', updated_at: '2026-10-27T12:00:00.000Z',
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

function renderOrders(rows: unknown[]) {
  mocks.from.mockReturnValue(emptyOrdersRequest(rows))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><MemoryRouter><OrdersPage /></MemoryRouter></QueryClientProvider>)
}

describe('customer WhatsApp actions', () => {
  it('provides separate desktop and mobile chat links without accepting or mutating the order', async () => {
    renderOrders([order])
    const table = await screen.findByRole('table')
    const card = screen.getByRole('article')
    const name = 'Escribir a Lucía por WhatsApp sobre PED-0001'
    const desktop = within(table).getByRole('link', { name })
    const mobile = within(card).getByRole('link', { name })
    for (const link of [desktop, mobile]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link).toHaveAttribute('title', name)
      expect(link.parentElement?.closest('a')).toBeNull()
      const destination = new URL(link.getAttribute('href')!)
      expect(destination.origin).toBe('https://wa.me')
      expect(destination.searchParams.get('text')).toContain('Somos Restaurante de prueba. Recibimos tu pedido PED-0001 y lo estamos preparando.')
      fireEvent.click(link)
    }
    expect(desktop).toHaveClass('icon-button')
    expect(mobile).toHaveClass('min-h-11')
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(within(table).queryByText('Generado')).not.toBeInTheDocument()
    expect(within(card).queryByText('Generado')).not.toBeInTheDocument()
    expect(within(table).getByText('Pagado · Pendiente de preparación')).toBeInTheDocument()
    expect(within(card).getByText('Pagado · Pendiente de preparación')).toBeInTheDocument()
  })

  it('uses neutral contact text while payment is pending', async () => {
    renderOrders([{ ...order, payment_status: 'pending' }])
    const table = await screen.findByRole('table')
    const link = within(table).getByRole('link', { name: /por WhatsApp/ })
    const text = new URL(link.getAttribute('href')!).searchParams.get('text')!
    expect(text).toContain('Te escribimos por tu pedido PED-0001.')
    expect(text).not.toContain('preparando')
    expect(within(table).getByText('Pago pendiente')).toBeInTheDocument()
  })

  it('does not render a chat link for an invalid phone in either layout', async () => {
    renderOrders([{ ...order, customer_phone: '+54invalid3492123456' }])
    const table = await screen.findByRole('table')
    const card = screen.getByRole('article')
    expect(within(table).queryByRole('link', { name: /por WhatsApp/ })).not.toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: /por WhatsApp/ })).not.toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Ver PED-0001' })).toBeInTheDocument()
  })
})

describe('order date range', () => {
  it('keeps the search field mounted and focused while a new filter loads', async () => {
    renderOrders([order])
    await screen.findByRole('table')
    let finish!: (value: { data: unknown[]; error: null; count: number }) => void
    const response = new Promise<{ data: unknown[]; error: null; count: number }>(resolve => { finish = resolve })
    const request = emptyOrdersRequest()
    request.then = (resolve, reject) => response.then(resolve, reject)
    mocks.from.mockReturnValue(request)
    const search = screen.getByLabelText('Buscar')
    search.focus()
    fireEvent.change(search, { target: { value: 'Lucía' } })
    expect(await screen.findByText('Actualizando pedidos…')).toBeVisible()
    expect(screen.getByLabelText('Buscar')).toBe(search)
    expect(search).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Exportar resultados' })).toBeDisabled()
    finish({ data: [order], error: null, count: 1 })
    await waitFor(() => expect(screen.queryByText('Actualizando pedidos…')).not.toBeInTheDocument())
    expect(search).toHaveFocus()
  })

  it('validates an inverted local-date range', () => {
    expect(orderDateRangeError('2026-09-30', '2026-09-29')).toBe(
      'La fecha Desde no puede ser posterior a la fecha Hasta.',
    )
    expect(orderDateRangeError('2026-09-29', '2026-09-29')).toBeNull()
  })

  it('keeps the filters visible and reports the validation inline', async () => {
    mocks.from.mockReturnValue(emptyOrdersRequest())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <OrdersPage />
      </QueryClientProvider>,
    )

    const from = await screen.findByLabelText('Desde')
    const to = screen.getByLabelText('Hasta')
    // Keep the first change invalid against any realistic current date so the
    // query does not briefly remount the filters between both events.
    fireEvent.change(from, { target: { value: '2099-09-30' } })
    fireEvent.change(to, { target: { value: '2099-09-29' } })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La fecha Desde no puede ser posterior a la fecha Hasta.',
    )
    expect(screen.getByRole('heading', { name: 'Pedidos' })).toBeVisible()
    expect(screen.getByLabelText('Buscar')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exportar resultados' })).toBeDisabled())
  })
})
