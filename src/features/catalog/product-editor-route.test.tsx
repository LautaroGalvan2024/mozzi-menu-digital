import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductEditorPage } from './ProductEditorPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  stock: vi.fn(),
  categories: [] as Array<{ id: string; name: string }>,
}))

vi.mock('../../lib/supabase/client', () => ({
  publicAssetUrl: () => null,
  supabase: {
    from: mocks.from,
    rpc: (name: string, args: unknown) => name === 'get_catalog_stock' ? mocks.stock(args) : mocks.rpc(name, args),
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
          <Route path="/admin/catalogo/productos" element={<h1>Listado de productos</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const existingId = '30000000-0000-4000-8000-000000000001'
async function openSection(label: string) {
  const summary = screen.getByText(label, { selector: 'summary', exact: false })
  if (!summary.closest('details')?.open) await userEvent.click(summary)
}
function stockResponse(onHand = '10', reserved = '3', version = '7', mode = 'enforced') {
  return { data: { policy: { mode, version: '1', cutoverId: null, businessConfirmed: true, businessPolicy: null }, items: [{ productId: existingId, initialized: true, onHand, reserved, available: String(BigInt(onHand) - BigInt(reserved)), version }] }, error: null }
}
function mockExistingProduct() {
  const categories = mocks.from.getMockImplementation()!
  mocks.from.mockImplementation((table: string) => {
    if (table === 'categories') return categories(table)
    if (table === 'products') return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: existingId, category_id: mocks.categories[0]!.id, code: 'FUN-1', name: 'Funda', description: '', base_price_cents: 10000, promotional_price_cents: null, promotion_starts_at: null, promotion_ends_at: null, image_path: null, active: true, available: true, featured: false, sort_order: 0 }, error: null }) }) }) }) }
    if (table === 'product_option_groups' || table === 'product_quantity_prices') return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }) }) }
    throw new Error(`Unexpected table: ${table}`)
  })
  mocks.stock.mockResolvedValue(stockResponse())
}

describe('new product route', () => {
  afterEach(cleanup)

  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    mocks.from.mockReset()
    mocks.rpc.mockReset()
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    mocks.stock.mockReset()
    mocks.stock.mockResolvedValue({ data: { policy: { mode: 'enforced', version: '1', cutoverId: null, businessConfirmed: true, businessPolicy: null }, items: [] }, error: null })
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

  it('keeps essentials visible and optional configuration folded until requested', async () => {
    renderNewProductRoute()
    expect(await screen.findByLabelText('Nombre')).toBeVisible()
    expect(screen.getByLabelText('Precio base')).toBeVisible()
    expect(screen.getByLabelText('Stock (unidades)')).toBeVisible()
    expect(screen.getByLabelText('Precio promocional')).not.toBeVisible()
    expect(screen.getByLabelText('Código / SKU (opcional)')).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Grupo' })).not.toBeVisible()
    await openSection('Promociones y precios especiales')
    expect(screen.getByLabelText('Precio promocional')).toBeVisible()
  })

  it('reopens a manually closed optional section when its values prevent saving', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()
    await user.type(await screen.findByLabelText('Nombre'), 'Funda')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await openSection('Promociones y precios especiales')
    await user.type(screen.getByLabelText('Precio promocional'), '150')
    await user.click(screen.getByText('Promociones y precios especiales', { selector: 'summary' }))
    expect(screen.getByLabelText('Precio promocional')).not.toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(screen.getByRole('alert')).toHaveTextContent('precios y la vigencia')
    expect(screen.getByLabelText('Precio promocional')).toBeVisible()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('creates without a code and keeps an informed code as text', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()
    await user.type(await screen.findByLabelText('Nombre'), 'Arroz')
    await openSection('Código y organización')
    expect(screen.getByText('Si lo dejás vacío, lo generamos automáticamente')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc).toHaveBeenCalledWith('save_product_catalog_with_stock', expect.objectContaining({ p_product: expect.objectContaining({ code: '' }), p_stock: null }))
    await screen.findByRole('heading', { name: 'Listado de productos' })
    cleanup()
    renderNewProductRoute()
    await user.type(await screen.findByLabelText('Nombre'), 'Fideos')
    await openSection('Código y organización')
    await user.type(screen.getByLabelText('Código / SKU (opcional)'), '000123')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_product_catalog_with_stock', expect.objectContaining({ p_product: expect.objectContaining({ code: '000123' }) }))
  })

  it('reuses the same product after a lost response and a remount', async () => {
    const user = userEvent.setup()
    mocks.rpc.mockRejectedValueOnce(new Error('Connection lost'))
    renderNewProductRoute()
    await user.type(await screen.findByLabelText('Nombre'), 'Arroz')
    await user.type(screen.getByLabelText('Stock (unidades)'), '12')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    await screen.findByRole('alert')
    const first = mocks.rpc.mock.calls[0]![1]
    expect(screen.getByLabelText('Stock (unidades)')).toBeDisabled()
    cleanup()
    renderNewProductRoute()
    expect(await screen.findByLabelText('Nombre')).toHaveValue('Arroz')
    expect(screen.getByLabelText('Stock (unidades)')).toHaveValue('12')
    await user.click(screen.getByRole('button', { name: 'Reintentar guardado' }))
    expect(mocks.rpc.mock.calls[1]![1]).toEqual(first)
    await screen.findByRole('heading', { name: 'Listado de productos' })
    expect(sessionStorage.getItem('mozzi:product-attempt:10000000-0000-4000-8000-000000000001')).toBeNull()
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

  it.each(['0', '25'])('creates a product and its explicit absolute stock %s in one operation', async quantity => {
    renderNewProductRoute()
    await userEvent.type(await screen.findByLabelText('Nombre'), 'Funda')
    await userEvent.type(screen.getByLabelText('Stock (unidades)'), quantity)
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.stock).toHaveBeenCalledWith({ p_restaurant_id: '10000000-0000-4000-8000-000000000001', p_product_ids: [] })
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('save_product_catalog_with_stock', expect.objectContaining({ p_operation_id: expect.any(String), p_stock: { onHand: quantity, expectedVersion: null }, p_product: expect.objectContaining({ name: 'Funda' }) }))
    await screen.findByRole('heading', { name: 'Listado de productos' })
  })

  it.each(['-1', '1.5', '1e3', '10000000000000'])('rejects invalid stock %s before sending a mutation', async quantity => {
    renderNewProductRoute()
    await userEvent.type(await screen.findByLabelText('Nombre'), 'Funda')
    await userEvent.type(screen.getByLabelText('Stock (unidades)'), quantity)
    expect(screen.getByLabelText('Stock (unidades)')).toHaveValue(quantity)
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(screen.getByRole('alert')).toHaveTextContent('cantidad entera')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves existing stock when editing only metadata, blank input=%s', async blank => {
    mockExistingProduct()
    renderExistingProductRoute(existingId)
    expect(await screen.findByLabelText('Stock (unidades)')).toHaveValue('10')
    expect(screen.getByText('Stock actual: 10 · Reservado: 3 · Disponible: 7')).toBeVisible()
    if (blank) await userEvent.clear(screen.getByLabelText('Stock (unidades)'))
    await userEvent.type(screen.getByLabelText('Nombre'), ' nueva')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc).toHaveBeenCalledWith('save_product_catalog_with_stock', expect.objectContaining({ p_stock: null }))
    await screen.findByRole('heading', { name: 'Listado de productos' })
  })

  it('validates reserved units and sends the reviewed absolute quantity with its original version', async () => {
    mockExistingProduct()
    renderExistingProductRoute(existingId)
    const input = await screen.findByLabelText('Stock (unidades)')
    await userEvent.clear(input)
    await userEvent.type(input, '2')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(screen.getByRole('alert')).toHaveTextContent('menor que las unidades reservadas')
    expect(mocks.rpc).not.toHaveBeenCalled()
    await userEvent.clear(input)
    await userEvent.type(input, '8')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc).toHaveBeenCalledWith('save_product_catalog_with_stock', expect.objectContaining({ p_stock: { onHand: '8', expectedVersion: '7' } }))
    await screen.findByRole('heading', { name: 'Listado de productos' })
  })

  it('requires a new explicit quantity after a concurrent stock change instead of replaying with a new version', async () => {
    mockExistingProduct()
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'INVENTORY_VERSION_CONFLICT' } })
    renderExistingProductRoute(existingId)
    const input = await screen.findByLabelText('Stock (unidades)')
    await userEvent.clear(input)
    await userEvent.type(input, '8')
    mocks.stock.mockResolvedValue(stockResponse('9', '4', '8'))
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('El stock cambió'))
    expect(input).toHaveValue('')
    expect(screen.getByText('Stock actual: 9 · Reservado: 4 · Disponible: 5')).toBeVisible()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    const firstOperation = mocks.rpc.mock.calls[0]![1].p_operation_id
    await userEvent.type(input, '8')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc.mock.calls[1]![1].p_stock).toEqual({ onHand: '8', expectedVersion: '8' })
    expect(mocks.rpc.mock.calls[1]![1].p_operation_id).not.toBe(firstOperation)
    await screen.findByRole('heading', { name: 'Listado de productos' })
  })

  it.each(['changed', 'unavailable'])('replays the exact saved edit after a lost response even if reloaded stock is %s', async state => {
    mockExistingProduct()
    mocks.rpc.mockRejectedValueOnce(new Error('Connection lost'))
    renderExistingProductRoute(existingId)
    await userEvent.clear(await screen.findByLabelText('Stock (unidades)'))
    await userEvent.type(screen.getByLabelText('Stock (unidades)'), '8')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    await screen.findByRole('alert')
    const first = mocks.rpc.mock.calls[0]![1]
    expect(screen.getByLabelText('Nombre')).toBeDisabled()
    cleanup()
    if (state === 'changed') mocks.stock.mockResolvedValue(stockResponse('7', '3', '9'))
    else mocks.stock.mockRejectedValue(new Error('Temporary connection error'))
    renderExistingProductRoute(existingId)
    expect(await screen.findByLabelText('Stock (unidades)')).toHaveValue('8')
    expect(screen.getByLabelText('Stock (unidades)')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }))
    expect(mocks.rpc.mock.calls[1]![1]).toEqual(first)
    await screen.findByRole('heading', { name: 'Listado de productos' })
    expect(localStorage.getItem(`mozzi:product-save:10000000-0000-4000-8000-000000000001:${existingId}`)).toBeNull()
  })

  it('allows catalog edits while stock is paused without sending a stock mutation', async () => {
    mockExistingProduct()
    mocks.stock.mockResolvedValue(stockResponse('10', '3', '7', 'paused'))
    renderExistingProductRoute(existingId)
    expect(await screen.findByLabelText('Stock (unidades)')).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Nombre'), ' nueva')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc).toHaveBeenCalledWith('save_product_catalog_with_stock', expect.objectContaining({ p_stock: null }))
    await screen.findByRole('heading', { name: 'Listado de productos' })
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
    await openSection('Código y organización')
    await user.type(screen.getByLabelText('Código / SKU (opcional)'), 'MIL-1')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await openSection('Promociones y precios especiales')
    await user.type(screen.getByLabelText('Precio promocional'), '150')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    expect(screen.getByRole('alert')).toHaveTextContent('precios')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a minimum option count that cannot be satisfied', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await user.type(await screen.findByLabelText('Nombre'), 'Milanesa')
    await openSection('Código y organización')
    await user.type(screen.getByLabelText('Código / SKU (opcional)'), 'MIL-2')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await openSection('Extras y adicionales')
    await user.click(screen.getByRole('button', { name: 'Grupo' }))
    await user.type(screen.getByLabelText('Nombre del grupo'), 'Salsas')
    await user.clear(screen.getByLabelText('Mínimo'))
    await user.type(screen.getByLabelText('Mínimo'), '1')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    expect(screen.getByRole('alert')).toHaveTextContent('límites')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a zero maximum before saving the catalogue', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()
    await user.type(await screen.findByLabelText('Nombre'), 'Arroz')
    await openSection('Extras y adicionales')
    await user.click(screen.getByRole('button', { name: 'Grupo' }))
    await user.type(screen.getByLabelText('Nombre del grupo'), 'Extras')
    await user.clear(screen.getByLabelText('Máximo'))
    await user.type(screen.getByLabelText('Máximo'), '0')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(screen.getByRole('alert')).toHaveTextContent('máximo debe estar entre 1 y 20')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects fractional cents instead of silently rounding a manual price', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()
    await user.type(await screen.findByLabelText('Nombre'), 'Arroz')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '1.234')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(screen.getByRole('alert')).toHaveTextContent('hasta dos decimales')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('sends active quantity prices inside the transactional product payload', async () => {
    const user = userEvent.setup()
    renderNewProductRoute()

    await user.type(await screen.findByLabelText('Nombre'), 'Empanada')
    await openSection('Código y organización')
    await user.type(screen.getByLabelText('Código / SKU (opcional)'), 'EMP-1')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await openSection('Promociones y precios especiales')
    await user.click(screen.getByRole('button', { name: 'Agregar precio' }))
    await user.clear(screen.getByLabelText('Precio total para 2 unidades'))
    await user.type(screen.getByLabelText('Precio total para 2 unidades'), '180')
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_product_catalog_with_stock',
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
    await openSection('Código y organización')
    await user.type(screen.getByLabelText('Código / SKU (opcional)'), 'EMP-2')
    await user.clear(screen.getByLabelText('Precio base'))
    await user.type(screen.getByLabelText('Precio base'), '100')
    await openSection('Promociones y precios especiales')
    await user.click(screen.getByRole('button', { name: 'Agregar precio' }))
    await openSection('Promociones y precios especiales')
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
    await openSection('Extras y adicionales')
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

    expect(await screen.findByRole('heading', { name: 'Editar producto' })).toBeVisible()
    expect(optionIn).toHaveBeenCalledWith('option_group_id', [groupId])
    expect(screen.getByLabelText('Precio total para 2 unidades')).toHaveValue(180)
    const user = userEvent.setup()
    await openSection('Código y organización')
    await user.clear(screen.getByLabelText('Código / SKU (opcional)'))
    await user.click(screen.getByRole('button', { name: 'Guardar producto' }))
    expect(mocks.rpc).toHaveBeenCalledWith('save_product_catalog_with_stock', expect.objectContaining({ p_product: expect.objectContaining({ id: productId, code: '' }) }))
  })
})
