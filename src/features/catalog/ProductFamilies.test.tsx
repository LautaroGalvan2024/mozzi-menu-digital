import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductFamilies } from './ProductFamilies'

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), save: vi.fn(), stock: vi.fn(), query: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: '20000000-0000-4000-8000-000000000001' } }) }))
const category = '30000000-0000-4000-8000-000000000001'
const black = '40000000-0000-4000-8000-000000000001'
const red = '40000000-0000-4000-8000-000000000002'
let familyRows: unknown[] = []
let existingFamily: string | null = null
function stockData(onHand = '10', reserved = '3', version = '7') {
  return { policy: { mode: 'enforced', version: '1', cutoverId: null, businessConfirmed: true, businessPolicy: {} }, items: [
    { productId: black, initialized: true, onHand, reserved, available: String(BigInt(onHand) - BigInt(reserved)), version },
    { productId: red, initialized: true, onHand: '5', reserved: '0', available: '5', version: '2' },
  ] }
}
function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><ProductFamilies /></MemoryRouter></QueryClientProvider>)
}
describe('variant family editing', () => {
  afterEach(() => { cleanup(); localStorage.clear() })
  beforeEach(() => {
    localStorage.clear(); familyRows = []; existingFamily = null
    mocks.rpc.mockReset(); mocks.from.mockReset(); mocks.save.mockReset(); mocks.stock.mockReset(); mocks.query.mockReset()
    mocks.save.mockResolvedValue({ data: { id: 'family', variants: 2 }, error: null })
    mocks.stock.mockResolvedValue({ data: stockData(), error: null })
    mocks.rpc.mockImplementation((name: string, payload: unknown) => name === 'get_catalog_stock' ? mocks.stock(payload) : mocks.save(name, payload))
    mocks.from.mockImplementation((table: string) => {
      const data = table === 'categories' ? [{ id: category, name: 'Fundas' }] : table === 'product_families' ? familyRows : [
        { id: black, code: 'BLACK', name: 'Funda negra', category_id: category, family_id: existingFamily, variant_attributes: existingFamily ? { Modelo: 'iPhone 15', Color: 'Negro' } : {}, image_path: null, base_price_cents: 1000 },
        { id: red, code: 'RED', name: 'Funda roja', category_id: category, family_id: null, variant_attributes: {}, image_path: null, base_price_cents: 1200 },
      ]
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit', 'range', 'or', 'abortSignal']) chain[method] = (...args: unknown[]) => { mocks.query(table, method, args); return chain }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null, count: data.length }).then(resolve)
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
  async function addExistingVariant(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Agrupar producto existente' }))
    await user.selectOptions(screen.getByLabelText('Producto existente'), black)
    await user.type(screen.getByLabelText('Modelo'), 'iPhone 15')
    await user.type(screen.getByLabelText('Color'), 'Negro')
  }
  it('requests stable pages of 50 and debounces family and candidate searches', async () => {
    const user = userEvent.setup()
    renderManager()
    await user.click(screen.getByRole('button', { name: /Productos con variantes/ }))
    await screen.findByRole('button', { name: 'Nueva ficha con variantes' })
    expect(mocks.query).toHaveBeenCalledWith('product_families', 'order', ['name'])
    expect(mocks.query).toHaveBeenCalledWith('product_families', 'order', ['id'])
    expect(mocks.query).toHaveBeenCalledWith('product_families', 'range', [0, 49])

    await user.type(screen.getByLabelText('Buscar familias'), 'silicona')
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith('product_families', 'or', ['name.ilike.%silicona%,code.ilike.%silicona%']))

    await user.click(screen.getByRole('button', { name: 'Nueva ficha con variantes' }))
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith('products', 'range', [0, 49]))
    await user.type(screen.getByLabelText('Buscar productos sin familia'), 'negra')
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith('products', 'or', ['name.ilike.%negra%,code.ilike.%negra%']))
  })
  it('contains keyboard focus in the variant editor and returns it after Escape', async () => {
    const user = await openFamily()
    const close = screen.getByRole('button', { name: 'Cerrar ficha' })
    const save = screen.getByRole('button', { name: 'Guardar ficha y variantes' })
    save.focus()
    expect(save).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(save).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nueva ficha con variantes' })).toHaveFocus()
  })
  it('groups existing physical SKUs without sending replacement prices or stock', async () => {
    const user = await openFamily()
    await user.click(screen.getByRole('button', { name: 'Agrupar producto existente' }))
    await user.selectOptions(screen.getByLabelText('Producto existente'), black)
    await user.type(screen.getByLabelText('Modelo'), 'iPhone 15')
    await user.type(screen.getByLabelText('Color'), 'Negro')
    expect(screen.getByLabelText('Cantidad en stock')).toHaveValue('10')
    expect(screen.getByLabelText('Cantidad en stock')).toHaveAccessibleDescription('Stock actual: 10. Reservadas: 3. Disponibles: 7.')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    expect(mocks.save.mock.calls[0]?.[0]).toBe('save_product_family_with_stock')
    expect(mocks.save.mock.calls[0]?.[1]).toMatchObject({ p_family: { name: 'Funda silicona', categoryId: category, axes: ['Modelo', 'Color'] }, p_variants: [{ productId: black, attributes: { Modelo: 'iPhone 15', Color: 'Negro' } }], p_stock_rows: [] })
    expect(mocks.save.mock.calls[0]?.[1].p_variants[0]).not.toHaveProperty('product')
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
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('retries a new variant with the same UUID after a lost response', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Se perdió la conexión'))
    const user = await openFamily()
    await user.click(screen.getByRole('button', { name: 'Crear nueva variante' }))
    await user.type(screen.getByLabelText('Modelo'), 'iPhone 16')
    await user.type(screen.getByLabelText('Color'), 'Azul')
    await user.clear(screen.getByLabelText('Precio de la variante'))
    await user.type(screen.getByLabelText('Precio de la variante'), '1500.50')
    await user.type(screen.getByLabelText('Cantidad en stock'), '8')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar el guardado')
    const first = mocks.save.mock.calls[0]?.[1]
    expect(screen.getByLabelText('Cantidad en stock')).toBeDisabled()
    expect(screen.getByLabelText('Nombre de la ficha')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reintentar guardado' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]?.[1]).toEqual(first)
    expect(first.p_variants[0].product).toMatchObject({ basePriceCents: 150050 })
    expect(first.p_stock_rows).toEqual([{ productId: first.p_variants[0].productId, onHand: '8', expectedVersion: null }])
    expect(mocks.stock.mock.calls[0]?.[0].p_product_ids).toEqual([black, red])
  })
  it('saves a final absolute quantity with its baseline version while editing an existing family', async () => {
    existingFamily = '50000000-0000-4000-8000-000000000001'
    familyRows = [{ id: existingFamily, code: 'FUNDAS', category_id: category, name: 'Funda silicona', description: '', image_path: null, axes: ['Modelo', 'Color'], active: true }]
    const user = userEvent.setup()
    renderManager()
    await user.click(screen.getByRole('button', { name: /Productos con variantes/ }))
    await user.click(await screen.findByRole('button', { name: 'Funda silicona' }))
    expect(await screen.findByLabelText('Cantidad en stock')).toHaveValue('10')
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.type(screen.getByLabelText('Cantidad en stock'), '20')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    expect(mocks.save.mock.calls[0]?.[1].p_stock_rows).toEqual([{ productId: black, onHand: '20', expectedVersion: '7' }])
    expect(mocks.save.mock.calls[0]?.[1].p_family.id).toBe(existingFamily)
  })
  it('omits stock when its field is blank and changes the baseline when another SKU is selected', async () => {
    const user = await openFamily()
    await addExistingVariant(user)
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.type(screen.getByLabelText('Cantidad en stock'), '25')
    await user.selectOptions(screen.getByLabelText('Producto existente'), red)
    expect(screen.getByLabelText('Cantidad en stock')).toHaveValue('5')
    expect(screen.getByLabelText('Cantidad en stock')).toHaveAccessibleDescription('Stock actual: 5. Reservadas: 0. Disponibles: 5.')
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    expect(mocks.save.mock.calls[0]?.[1].p_stock_rows).toEqual([])
    expect(mocks.save.mock.calls[0]?.[1].p_variants[0].productId).toBe(red)
  })
  it.each(['-1', '1.5', '10000000000000', '1e2'])('rejects invalid stock quantity %s before saving', async (quantity) => {
    const user = await openFamily()
    await addExistingVariant(user)
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.type(screen.getByLabelText('Cantidad en stock'), quantity)
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('cantidad entera')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('does not lower physical stock below current reservations', async () => {
    const user = await openFamily()
    await addExistingVariant(user)
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.type(screen.getByLabelText('Cantidad en stock'), '2')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no puede ser menor que las unidades reservadas')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('requires an explicit review and a newly entered quantity after a concurrent stock change', async () => {
    mocks.save.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'INVENTORY_VERSION_CONFLICT' } })
    const user = await openFamily()
    await addExistingVariant(user)
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.type(screen.getByLabelText('Cantidad en stock'), '14')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('El stock cambió')
    expect(screen.getByRole('button', { name: 'Guardar ficha y variantes' })).toBeDisabled()
    expect(mocks.stock).toHaveBeenCalledOnce()
    mocks.stock.mockResolvedValue({ data: stockData('4', '1', '8'), error: null })
    await user.click(screen.getByRole('button', { name: 'Actualizar stock de variantes' }))
    await waitFor(() => expect(screen.getByLabelText('Cantidad en stock')).toBeEnabled())
    expect(screen.getByLabelText('Cantidad en stock')).toHaveValue('')
    expect(screen.getByLabelText('Cantidad en stock')).toHaveAccessibleDescription('Stock actual: 4. Reservadas: 1. Disponibles: 3.')
    expect(mocks.save).toHaveBeenCalledOnce()
    await user.type(screen.getByLabelText('Cantidad en stock'), '6')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]?.[1].p_stock_rows).toEqual([{ productId: black, onHand: '6', expectedVersion: '8' }])
    expect(mocks.save.mock.calls[1]?.[1].p_operation_id).not.toBe(mocks.save.mock.calls[0]?.[1].p_operation_id)
  })
  it('recovers an uncertain stock save after remount with the exact same operation and payload', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Connection lost after commit'))
    const user = await openFamily()
    await addExistingVariant(user)
    await user.clear(screen.getByLabelText('Cantidad en stock'))
    await user.type(screen.getByLabelText('Cantidad en stock'), '12')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos confirmar')
    const original = mocks.save.mock.calls[0]?.[1]
    cleanup()
    mocks.stock.mockResolvedValue({ data: stockData('11', '3', '9'), error: null })
    renderManager()
    await screen.findByRole('dialog')
    expect(screen.getByLabelText('Cantidad en stock')).toHaveValue('12')
    expect(screen.getByLabelText('Cantidad en stock')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reintentar guardado' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]?.[1]).toEqual(original)
    expect(localStorage.getItem('mozzi:family-save:20000000-0000-4000-8000-000000000001')).toBeNull()
  })
  it('lets catalog metadata save without stock changes while inventory is paused', async () => {
    const paused = stockData(); paused.policy.mode = 'paused'
    mocks.stock.mockResolvedValue({ data: paused, error: null })
    const user = await openFamily()
    await addExistingVariant(user)
    expect(screen.getByLabelText('Cantidad en stock')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    expect(mocks.save.mock.calls[0]?.[1].p_stock_rows).toEqual([])
  })
  it('preserves an untouched legacy balance above the new entry limit', async () => {
    mocks.stock.mockResolvedValue({ data: stockData('9007199254740991', '3', '10'), error: null })
    const user = await openFamily()
    await addExistingVariant(user)
    expect(screen.getByLabelText('Cantidad en stock')).toHaveValue('9007199254740991')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    expect(mocks.save.mock.calls[0]?.[1].p_stock_rows).toEqual([])
  })
  it('sends an explicit zero for a newly created variant without querying its unsaved UUID', async () => {
    const user = await openFamily()
    await user.click(screen.getByRole('button', { name: 'Crear nueva variante' }))
    await user.type(screen.getByLabelText('Modelo'), 'iPhone 16')
    await user.type(screen.getByLabelText('Color'), 'Azul')
    await user.type(screen.getByLabelText('Cantidad en stock'), '0')
    await user.click(screen.getByRole('button', { name: 'Guardar ficha y variantes' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
    const request = mocks.save.mock.calls[0]?.[1]
    expect(request.p_stock_rows).toEqual([{ productId: request.p_variants[0].productId, onHand: '0', expectedVersion: null }])
    expect(mocks.stock.mock.calls[0]?.[0].p_product_ids).toEqual([black, red])
  })
})
