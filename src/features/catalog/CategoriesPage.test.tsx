import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoriesPage } from './CategoriesPage'

const restaurantId = '10000000-0000-4000-8000-000000000001'
const categoryId = '20000000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({ supabase: { from: mocks.from } }))
vi.mock('../../lib/images/responsive', () => ({
  responsiveAssetUrls: (path: string | null) => path
    ? { src: `https://assets.example/${path}`, srcSet: undefined }
    : { src: null, srcSet: undefined },
}))
vi.mock('../restaurants/RestaurantScope', () => ({
  useRestaurantScope: () => ({ selected: { id: restaurantId } }),
}))

let rows: Array<Record<string, unknown>> = []

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><CategoriesPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('category icon management', () => {
  afterEach(cleanup)

  beforeEach(() => {
    rows = [{
      id: categoryId,
      restaurant_id: restaurantId,
      name: 'Bebidas',
      slug: 'bebidas',
      description: '',
      image_path: null,
      icon_key: 'drinks',
      sort_order: 0,
      active: true,
      deleted_at: null,
    }]
    mocks.from.mockReset()
    mocks.update.mockReset()
    mocks.insert.mockReset()
    mocks.query.mockReset()
    mocks.from.mockImplementation((table: string) => {
      let operation: 'read' | 'update' | 'insert' = 'read'
      const chain: Record<string, unknown> = {}
      chain.select = (columns: string) => { mocks.query(table, 'select', columns); return chain }
      chain.eq = (column: string, value: unknown) => { mocks.query(table, 'eq', column, value); return chain }
      chain.is = (column: string, value: unknown) => { mocks.query(table, 'is', column, value); return chain }
      chain.order = (column: string) => { mocks.query(table, 'order', column); return chain }
      chain.update = (payload: unknown) => { operation = 'update'; mocks.update(payload); return chain }
      chain.insert = (payload: unknown) => { operation = 'insert'; mocks.insert(payload); return chain }
      chain.maybeSingle = () => Promise.resolve({ data: { id: categoryId, restaurant_id: restaurantId }, error: null })
      chain.single = () => Promise.resolve({ data: { id: categoryId, restaurant_id: restaurantId }, error: null })
      chain.then = (resolve: (value: unknown) => unknown) => {
        const value = operation === 'read' ? { data: rows, error: null } : { data: null, error: null }
        return Promise.resolve(value).then(resolve)
      }
      return chain
    })
  })

  it('loads the explicit icon column and persists a visual radio choice within the tenant', async () => {
    const user = userEvent.setup()
    renderPage()

    const categoryButton = await screen.findByRole('button', { name: /Bebidas/ })
    expect(categoryButton.querySelector('[data-category-icon="drinks"]')).toBeInTheDocument()
    expect(mocks.query).toHaveBeenCalledWith('categories', 'select', expect.stringContaining('icon_key'))

    await user.click(categoryButton)
    const dialog = screen.getByRole('dialog', { name: 'Editar categoría' })
    expect(within(dialog).getByRole('radio', { name: 'Bebidas' })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: /Infusiones/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ icon_key: 'infusions' })))
    expect(mocks.query).toHaveBeenCalledWith('categories', 'eq', 'restaurant_id', restaurantId)
    expect(mocks.query).toHaveBeenCalledWith('categories', 'eq', 'id', categoryId)
  })

  it('stores Automatic as null and keeps an existing category image ahead of its icon', async () => {
    rows[0] = { ...rows[0], image_path: 'categories/bebidas.webp', icon_key: 'drinks' }
    const user = userEvent.setup()
    renderPage()

    const categoryButton = await screen.findByRole('button', { name: /Bebidas/ })
    expect(categoryButton.querySelector('img')).toHaveAttribute('src', 'https://assets.example/categories/bebidas.webp')
    expect(categoryButton.querySelector('[data-category-icon]')).not.toBeInTheDocument()

    await user.click(categoryButton)
    const dialog = screen.getByRole('dialog', { name: 'Editar categoría' })
    await user.click(within(dialog).getByRole('radio', { name: /Automático/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ icon_key: null })))
  })
})
