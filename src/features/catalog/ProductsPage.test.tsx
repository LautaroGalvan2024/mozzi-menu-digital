import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductsPage } from './ProductsPage'

const mocks = vi.hoisted(() => ({ from: vi.fn() }))

vi.mock('../../lib/supabase/client', () => ({ supabase: { from: mocks.from } }))
vi.mock('../restaurants/RestaurantScope', () => ({
  useRestaurantScope: () => ({ selected: { id: '10000000-0000-4000-8000-000000000001' } }),
}))
vi.mock('../restaurants/useRestaurant', () => ({
  useRestaurant: () => ({ data: { currency_code: 'ARS', locale: 'es-AR' }, isLoading: false, error: null }),
}))
vi.mock('./ProductFamilies', () => ({ ProductFamilies: () => <button type="button">Variantes</button> }))
vi.mock('./ProductImagesExport', () => ({ ProductImagesExport: () => <button type="button">Descargar imágenes</button> }))

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><ProductsPage /></MemoryRouter></QueryClientProvider>)
}

describe('products command bar', () => {
  beforeEach(() => {
    const request: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'is', 'order', 'range', 'abortSignal']) request[method] = () => request
    request.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve)
    mocks.from.mockReturnValue(request)
  })

  it('groups search, count and catalog actions without the old cards', async () => {
    const user = userEvent.setup()
    const view = renderPage()
    const toolbar = await screen.findByRole('textbox', { name: 'Buscar productos' }).then(input => input.closest('.catalog-command-bar'))
    expect(toolbar).not.toBeNull()
    const controls = within(toolbar as HTMLElement)
    expect(controls.getByRole('status')).toHaveTextContent('0 productos')
    expect(controls.getByRole('link', { name: 'Nuevo producto' })).toHaveAttribute('href', '/admin/catalogo/productos/nuevo')
    expect(controls.getByRole('button', { name: 'Variantes' })).toBeInTheDocument()
    const more = controls.getByText('Más acciones').closest('summary')
    expect(more).not.toBeNull()
    await user.click(more as HTMLElement)
    expect(more?.parentElement).toHaveAttribute('open')
    expect(controls.getByRole('button', { name: 'Descargar imágenes' })).toBeInTheDocument()
    expect(view.container.querySelector('.catalog-command-bar')).toBeInTheDocument()
    expect(view.container.querySelector('.catalog-data-region')).toBeInTheDocument()
  })
})
