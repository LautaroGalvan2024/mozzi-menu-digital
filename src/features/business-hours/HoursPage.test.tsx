import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoursPage } from './HoursPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
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

describe('initial restaurant hours', () => {
  afterEach(cleanup)

  beforeEach(() => {
    mocks.from.mockReset()
    mocks.rpc.mockReset()
    mocks.rpc.mockResolvedValue({
      data: { regular: 1, special: 0 },
      error: null,
    })
    mocks.from.mockImplementation((table: string) => {
      if (table === 'business_hours') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'special_hours') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    })
  })

  it('adds and persists the first shift of an empty restaurant', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <HoursPage />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Horarios' })).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: 'Agregar turno' })[0]!)
    expect(screen.getByLabelText('Abre')).toHaveValue('09:00')
    expect(screen.getByLabelText('Cierra')).toHaveValue('13:00')

    await user.click(screen.getByRole('button', { name: 'Guardar horarios' }))

    expect(mocks.rpc).toHaveBeenCalledWith('save_restaurant_hours', {
      p_restaurant_id: '10000000-0000-4000-8000-000000000001',
      p_regular: [{
        id: expect.any(String),
        dayOfWeek: 0,
        slotIndex: 0,
        opensAt: '09:00',
        closesAt: '13:00',
        spansNextDay: false,
        active: true,
      }],
      p_special: [],
      p_delete_regular_ids: [],
      p_delete_special_ids: [],
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Horarios guardados')
  })

  it('rejects mixing a full-day closure with another exception on the same date', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <HoursPage />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Horarios' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Agregar' }))
    await user.click(screen.getAllByRole('button', { name: 'Agregar' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Guardar horarios' }))

    expect(screen.getByRole('alert')).toHaveTextContent('no se puede combinar')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
