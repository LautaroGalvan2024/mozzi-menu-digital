import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OrdersPage, orderDateRangeError } from './OrdersPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  removeChannel: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: {
    from: mocks.from,
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

function emptyOrdersRequest() {
  const request: Record<string, unknown> & PromiseLike<{ data: unknown[]; error: null; count: number }> = {
    then(resolve, reject) {
      return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject)
    },
  }
  for (const method of ['select', 'eq', 'gte', 'lt', 'order', 'range', 'ilike']) {
    request[method] = () => request
  }
  return request
}

describe('order date range', () => {
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
