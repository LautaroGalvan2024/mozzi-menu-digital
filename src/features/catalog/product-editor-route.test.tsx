import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductEditorPage } from './ProductEditorPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  categories: [] as Array<{ id: string; name: string }>,
}))

vi.mock('../../lib/supabase/client', () => ({
  publicAssetUrl: () => null,
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: { from: vi.fn() },
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

function renderNewProductRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/admin/catalogo/productos/nuevo']}>
        <Routes>
          <Route
            path="/admin/catalogo/productos/nuevo"
            element={<ProductEditorPage />}
          />
          <Route
            path="/admin/catalogo/productos"
            element={<h1>Listado de productos</h1>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderExistingProductRoute(productId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/admin/catalogo/productos/${productId}`]}>
        <Routes>
          <Route path="/admin/catalogo/productos/:productId" element={<ProductEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('new product route', () => {
  afterEach(cleanup)

  beforeEach(() => {
    mocks.from.mockReset()
    mocks.rpc.mockReset()
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    mocks.categories = [{
      id: '20000000-0000-4000-8000-000000000001',
      name: 'Hamburguesas',
    }]
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            eq: () => ({
              order: async () => ({ data: mocks.categories, error: null }),
            }),
          }),
        }),
      }),
    }))
  })

  it('treats the literal /nuevo route as a new product', async () => {
    renderNewProductRoute()

    expect(await screen.findByRole('heading', { name: 'Nuevo producto' })).toBeVisible()
    expect(screen.getByLabelText('Nombre')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Listado de productos' })).not.toBeInTheDocument()
  })

  it('explains that an active category is required instead of loading forever', async () => {
    mocks.categories = []
    renderNewProductRoute()

    expect(await screen.findByRole('heading', { name: 'Primero creá una categoría' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Crear categoría' })).toHaveAttribute(
      'href',
      '/admin/catalogo/categorias',
    )
  })

  it('shows a category loading error instead of loading forever', async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            eq: () => ({
              order: async () => ({ data: null, error: { message: 'query failed' } }),
            }),
          }),
        }),
      }),
    }))
    renderNewProductRoute()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudieron cargar las categorías.',
    )
  })

  it('rejects a promotional price above the base price', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await user.type(await screen.findByLabelText('Nombre'), 'Milanesa')
    await user.type(screen.getByLabelText('Código único'), 'MIL-1')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await user.type(screen.getByLabelText('Precio promocional'), '150')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    expect(screen.getByRole('alert')).toHaveTextContent('precios')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a minimum option count that cannot be satisfied', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await user.type(await screen.findByLabelText('Nombre'), 'Milanesa')
    await user.type(screen.getByLabelText('Código único'), 'MIL-2')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await user.click(screen.getByRole('button', { name: 'Grupo' }))
    await user.type(screen.getByLabelText('Nombre del grupo'), 'Salsas')
    await user.clear(screen.getByLabelText('Mínimo'))
    await user.type(screen.getByLabelText('Mínimo'), '1')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    expect(screen.getByRole('alert')).toHaveTextContent('límites')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('sends active quantity prices inside the transactional product payload', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await user.type(await screen.findByLabelText('Nombre'), 'Empanada')
    await user.type(screen.getByLabelText('Código único'), 'EMP-1')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await user.click(screen.getByRole('button', { name: 'Agregar precio' }))
    await user.clear(screen.getByLabelText('Precio total para 2 unidades'))
    await user.type(screen.getByLabelText('Precio total para 2 unidades'), '180')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_product_catalog',
      expect.objectContaining({
        p_product: expect.objectContaining({
          quantityPrices: [{ quantity: 2, totalPriceCents: 18_000 }],
        }),
      }),
    ))
  })

  it('rejects duplicate quantity rules before calling the RPC', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await user.type(await screen.findByLabelText('Nombre'), 'Empanada')
    await user.type(screen.getByLabelText('Código único'), 'EMP-2')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await user.click(screen.getByRole('button', { name: 'Agregar precio' }))
    await user.click(screen.getByRole('button', { name: 'Agregar precio' }))
    const duplicateQuantity = screen.getByLabelText('Cantidad del precio especial 3')
    await user.clear(duplicateQuantity)
    await user.type(duplicateQuantity, '2')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    expect(screen.getByRole('alert')).toHaveTextContent('cada cantidad entre 2 y 20')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('resets the minimum to zero when a group stops being required', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await screen.findByRole('heading', { name: 'Nuevo producto' })
    await user.click(screen.getByRole('button', { name: 'Grupo' }))
    const required = screen.getByRole('checkbox', { name: 'Obligatorio' })
    await user.click(required)
    expect(screen.getByLabelText('Mínimo')).toHaveValue(1)
    await user.click(required)
    expect(screen.getByLabelText('Mínimo')).toHaveValue(0)
  })

  it('loads options only from the current product groups', async () => {
    const productId = '30000000-0000-4000-8000-000000000001'
    const groupId = '40000000-0000-4000-8000-000000000001'
    const optionIn = vi.fn(() => ({
      eq: () => ({
        order: async () => ({
          data: [{ id: '50000000-0000-4000-8000-000000000001', option_group_id: groupId, name: 'Cheddar', price_delta_cents: 5000, sort_order: 0, active: true }],
          error: null,
        }),
      }),
    }))
    mocks.from.mockImplementation((table: string) => {
      if (table === 'categories') return {
        select: () => ({ eq: () => ({ is: () => ({ eq: () => ({ order: async () => ({ data: mocks.categories, error: null }) }) }) }) }),
      }
      if (table === 'products') return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: productId, category_id: mocks.categories[0]!.id, code: 'BUR-1', name: 'Burger', description: '', base_price_cents: 10000, promotional_price_cents: null, promotion_starts_at: null, promotion_ends_at: null, image_path: null, active: true, available: true, featured: false, sort_order: 0 },
                error: null,
              }),
            }),
          }),
        }),
      }
      if (table === 'product_option_groups') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [{ id: groupId, name: 'Queso', required: false, min_select: 0, max_select: 1, sort_order: 0, active: true }], error: null }) }) }) }) }),
      }
      if (table === 'product_quantity_prices') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [{ id: '60000000-0000-4000-8000-000000000001', quantity: 2, total_price_cents: 18000 }], error: null }) }) }) }) }),
      }
      if (table === 'product_options') return {
        select: () => ({ eq: () => ({ in: optionIn }) }),
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    renderExistingProductRoute(productId)

    expect(await screen.findByRole('heading', { name: 'Editar Burger' })).toBeVisible()
    expect(optionIn).toHaveBeenCalledWith('option_group_id', [groupId])
    expect(screen.getByLabelText('Precio total para 2 unidades')).toHaveValue(180)
  })
})
