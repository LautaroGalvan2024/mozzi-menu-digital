import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductFamilies } from './ProductFamilies'

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: '20000000-0000-4000-8000-000000000001' } }) }))
const category = '30000000-0000-4000-8000-000000000001'
const black = '40000000-0000-4000-8000-000000000001'
const red = '40000000-0000-4000-8000-000000000002'
function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><ProductFamilies /></MemoryRouter></QueryClientProvider>)
}
describe('variant family editing', () => {
  afterEach(cleanup)
  beforeEach(() => {
    mocks.rpc.mockReset(); mocks.from.mockReset()
    mocks.rpc.mockResolvedValue({ data: { id: 'family', variants: 2 }, error: null })
    mocks.from.mockImplementation((table: string) => {
      const data = table === 'categories' ? [{ id: category, name: 'Fundas' }] : table === 'product_families' ? [] : [
        { id: black, code: 'BLACK', name: 'Funda negra', category_id: category, family_id: null, variant_attributes: {}, image_path: null, base_price_cents: 1000 },
        { id: red, code: 'RED', name: 'Funda roja', category_id: category, family_id: null, variant_attributes: {}, image_path: null, base_price_cents: 1200 },
      ]
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'is', 'order', 'limit']) chain[method] = () => chain
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve)
      return chain
    })
  })
  async function openFamily() {
    const user = userEvent.setup()
    renderManager()
    await user.click(screen.getByRole('button', { name: /Productos con variantes/ }))
    await user.click(await screen.findByRole('button', { name: 'Nueva ficha con variantes' }))
    await user.type(screen.getByLabelText('Nombre de la ficha'), 'Funda silicona')
    return user
  }
  it('groups existing physical SKUs without sending replacement prices or stock', async () => {
    const user = await openFamily()
    await user.click(screen.getByRole('button', { name: 'Agrupar producto existente' }))
    await user.selectOptions(screen.getByLabelText('Producto existente'), black)
    await user.type(screen.getByLabelText('Modelo'), 'iPhone 15')
    await user.type(screen.getByLabelText('Color'), 'Negro')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
    expect(mocks.rpc.mock.calls[0]?.[0]).toBe('save_product_family')
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_family: { name: 'Funda silicona', categoryId: category, axes: ['Modelo', 'Color'] }, p_variants: [{ productId: black, attributes: { Modelo: 'iPhone 15', Color: 'Negro' } }] })
    expect(mocks.rpc.mock.calls[0]?.[1].p_variants[0]).not.toHaveProperty('product')
    expect(await screen.findByRole('status')).toHaveTextContent('Ficha guardada')
  })
  it('blocks duplicate attribute combinations before submitting', async () => {
    const user = await openFamily()
    for (let index = 0; index < 2; index++) {
      await user.click(screen.getByRole('button', { name: 'Agrupar producto existente' }))
      await user.selectOptions(screen.getAllByLabelText('Producto existente')[index]!, index === 0 ? black : red)
      await user.type(screen.getAllByLabelText('Modelo')[index]!, 'iPhone 15')
      await user.type(screen.getAllByLabelText('Color')[index]!, 'Negro')
    }
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('combinación única')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('retries a new variant with the same UUID after a lost response', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('Se perdió la conexión'))
    const user = await openFamily()
    await user.click(screen.getByRole('button', { name: 'Crear nueva variante' }))
    await user.type(screen.getByLabelText('Modelo'), 'iPhone 16')
    await user.type(screen.getByLabelText('Color'), 'Azul')
    await user.clear(screen.getByLabelText('Precio de la variante'))
    await user.type(screen.getByLabelText('Precio de la variante'), '1500.50')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Se perdió la conexión')
    const first = mocks.rpc.mock.calls[0]?.[1]
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    expect(mocks.rpc.mock.calls[1]?.[1]).toEqual(first)
    expect(first.p_variants[0].product).toMatchObject({ basePriceCents: 150050 })
  })
})
