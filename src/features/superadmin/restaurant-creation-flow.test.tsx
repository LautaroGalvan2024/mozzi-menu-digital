import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateRestaurantPage } from './CreateRestaurantPage'
import { SuperRestaurantDetailPage } from './RestaurantDetailPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  invoke: vi.fn(),
  listRestaurantMembers: vi.fn(),
  selectRestaurant: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: {
    from: mocks.from,
    functions: { invoke: mocks.invoke },
  },
}))

vi.mock('../restaurants/member-directory', () => ({
  listRestaurantMembers: mocks.listRestaurantMembers,
}))

vi.mock('../restaurants/RestaurantScope', () => ({
  useRestaurantScope: () => ({
    choices: [{ id: '10000000-0000-4000-8000-000000000001', name: 'Restaurante Prueba', slug: 'restaurante-prueba', status: 'draft', role: 'super_admin' }],
    selected: null,
    selectRestaurant: mocks.selectRestaurant,
    loading: false,
  }),
}))

const restaurantId = '10000000-0000-4000-8000-000000000001'
const administratorId = '20000000-0000-4000-8000-000000000001'

describe('restaurant creation frontend flow', () => {
  beforeEach(() => {
    mocks.from.mockReset()
    mocks.invoke.mockReset()
    mocks.listRestaurantMembers.mockReset()
    mocks.selectRestaurant.mockReset()

    mocks.invoke.mockResolvedValue({
      data: { restaurant: { id: restaurantId, status: 'draft' } },
      error: null,
    })
    mocks.listRestaurantMembers.mockResolvedValue([{
      id: '30000000-0000-4000-8000-000000000001',
      user_id: administratorId,
      role: 'restaurant_admin',
      status: 'invited',
      created_at: '2026-09-29T12:00:00.000Z',
      profiles: { full_name: 'Admin de prueba', email: 'admin@example.com', active: true },
    }])

    const single = vi.fn().mockResolvedValue({
      data: {
        id: restaurantId,
        name: 'Restaurante Prueba',
        trade_name: 'Restaurante Prueba',
        slug: 'restaurante-prueba',
        description: 'Alta integral',
        status: 'draft',
        whatsapp_phone_e164: '+5493515555555',
        address: 'Calle Prueba 123',
        city: 'Córdoba',
        timezone: 'America/Argentina/Cordoba',
        currency_code: 'ARS',
        locale: 'es-AR',
        logo_path: null,
        cover_path: null,
        primary_color: '#ea580c',
        secondary_color: '#1c1917',
        delivery_enabled: true,
        pickup_enabled: true,
        minimum_order_cents: 0,
        default_preparation_minutes: 30,
        public_menu_enabled: false,
        updated_at: '2026-09-29T12:00:00.000Z',
      },
      error: null,
    })
    const eq = vi.fn(() => ({ single }))
    const select = vi.fn(() => ({ eq }))
    mocks.from.mockReturnValue({ select })
  })

  it('submits the Edge Function payload and renders the newly created draft detail', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/superadmin/restaurantes/nuevo']}>
          <Routes>
            <Route path="/superadmin/restaurantes/nuevo" element={<CreateRestaurantPage />} />
            <Route path="/superadmin/restaurantes/:id" element={<SuperRestaurantDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await user.type(screen.getByLabelText('Nombre interno'), 'Restaurante Prueba')
    await user.type(screen.getByLabelText('Nombre comercial'), 'Restaurante Prueba')
    await user.type(screen.getByLabelText('Slug'), 'restaurante-prueba')
    await user.type(screen.getByLabelText('WhatsApp E.164'), '+5493515555555')
    await user.type(screen.getByLabelText('Descripción'), 'Alta integral')
    await user.type(screen.getByLabelText('Dirección'), 'Calle Prueba 123')
    await user.type(screen.getByLabelText('Ciudad'), 'Córdoba')
    await user.type(screen.getByLabelText('Nombre completo'), 'Admin de prueba')
    await user.type(screen.getByLabelText('Correo'), 'admin@example.com')
    await user.click(screen.getByRole('button', { name: 'Crear e invitar' }))

    expect(await screen.findByRole('heading', { name: 'Restaurante Prueba' })).toBeVisible()
    expect(screen.getByText('/restaurante-prueba · Córdoba · draft')).toBeVisible()
    expect(screen.getByText('Admin de prueba')).toBeVisible()
    expect(screen.getByText('admin@example.com')).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('create-restaurant', {
      body: expect.objectContaining({
        idempotencyKey: expect.any(String),
        name: 'Restaurante Prueba',
        slug: 'restaurante-prueba',
        administrator: { fullName: 'Admin de prueba', email: 'admin@example.com' },
      }),
    })
    expect(mocks.from).toHaveBeenCalledWith('restaurants')
    expect(mocks.listRestaurantMembers).toHaveBeenCalledWith(restaurantId)
  })
})
