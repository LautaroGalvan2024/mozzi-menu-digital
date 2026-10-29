import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SuperRestaurantDetailPage } from './RestaurantDetailPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  listRestaurantMembers: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: { from: mocks.from },
}))

vi.mock('../restaurants/member-directory', () => ({
  listRestaurantMembers: mocks.listRestaurantMembers,
}))

const restaurantId = 'b5c7b84d-e30c-4ad7-a9b3-cb9e47ae4610'

beforeEach(() => {
  localStorage.clear()
  mocks.from.mockReset()
  mocks.listRestaurantMembers.mockReset()
  mocks.listRestaurantMembers.mockResolvedValue([])

  const single = vi.fn().mockResolvedValue({
    data: {
      id: restaurantId,
      name: 'Restaurante publicado',
      trade_name: 'Restaurante publicado',
      slug: 'restaurante-publicado',
      description: '',
      status: 'active',
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
      public_menu_enabled: true,
      updated_at: '2026-10-29T12:00:00.000Z',
    },
    error: null,
  })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  mocks.from.mockReturnValue({ select })
})

afterEach(cleanup)

it('loads without restaurant scope and selects the commerce before opening its admin', async () => {
  const user = userEvent.setup()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/superadmin/restaurantes/${restaurantId}`]}>
        <Routes>
          <Route path="/superadmin/restaurantes/:id" element={<SuperRestaurantDetailPage />} />
          <Route path="/admin" element={<p>Panel seleccionado</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(await screen.findByRole('heading', { name: 'Restaurante publicado' })).toBeVisible()
  await user.click(screen.getByRole('link', { name: 'Administrar' }))

  expect(await screen.findByText('Panel seleccionado')).toBeVisible()
  expect(localStorage.getItem('mozzi:selected-restaurant')).toBe(restaurantId)
  expect(mocks.listRestaurantMembers).toHaveBeenCalledWith(restaurantId)
  queryClient.clear()
})
