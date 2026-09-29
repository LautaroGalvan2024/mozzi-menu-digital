import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AdminLayout } from './AdminLayout'

vi.mock('../features/auth/AuthProvider', () => ({
  useAuth: () => ({
    isSuperAdmin: false,
    assuranceLevel: 'aal1',
    profile: { fullName: 'Admin de prueba' },
    user: { email: 'admin@example.test' },
    signOut: vi.fn(),
  }),
}))

vi.mock('../features/restaurants/RestaurantScope', () => ({
  useRestaurantScope: () => ({
    loading: false,
    choices: [{
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: 'restaurant_admin',
    }],
    selected: {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: 'restaurant_admin',
    },
    selectRestaurant: vi.fn(),
  }),
}))

describe('restaurant administrator navigation', () => {
  it('exposes the logo and cover configuration screen', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<h1>Resumen</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Marca' })).toHaveAttribute(
      'href',
      '/admin/marca',
    )
  })
})
