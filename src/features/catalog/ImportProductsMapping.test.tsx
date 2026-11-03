import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetData } from 'read-excel-file/browser'
import { ImportProductsPage } from './ImportProductsPage'

const commerceA = '10000000-0000-4000-8000-000000000001'
const commerceB = '10000000-0000-4000-8000-000000000002'
const mocks = vi.hoisted(() => ({ read: vi.fn(), invoke: vi.fn(), rpc: vi.fn(), selectedId: '10000000-0000-4000-8000-000000000001' }))
vi.mock('../../lib/import-file', () => ({ readImportFile: mocks.read, MAX_SPREADSHEET_BYTES: 10 * 1024 * 1024 }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc } }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: mocks.selectedId } }) }))

const external = (price = '$ 1.250,50'): Record<string, SheetData> => ({ Artículos: [
  ['Clave externa', 'Artículo', 'Rubro', 'Lista local', 'Costo'],
  ['000123', 'Arroz', 'Almacén', price, '700'],
] })
const canonical = (name = 'Arroz'): Record<string, SheetData> => ({ Productos: [
  ['codigo', 'nombre', 'categoria', 'precio'], ['000123', name, 'Almacén', '1250.50'],
] })

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = () => <QueryClientProvider client={client}><ImportProductsPage/></QueryClientProvider>
  const view = render(tree())
  return { ...view, switchCommerce: (id: string) => { mocks.selectedId = id; view.rerender(tree()) } }
}

function upload(container: HTMLElement, name = 'exportacion.xls') {
  fireEvent.change(container.querySelector('input[accept^=".xlsx"]')!, { target: { files: [new File(['content'], name)] } })
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => Promise.resolve(callback()) } })
  mocks.selectedId = commerceA
  mocks.read.mockReset()
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null })
  mocks.invoke.mockReset().mockImplementation((_name, request) => Promise.resolve({ data: {
    batchId: request.body.batchId,
    summary: { created: 0, updated: request.body.products.length, skipped: 0 }, errors: [],
    products: request.body.products.map((product: { rowRef: string; code: string }, index: number) => ({ rowRef: product.rowRef, code: product.code, id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, outcome: 'updated' })),
  }, error: null }))
})
afterEach(cleanup)

describe('flexible import review', () => {
  it('maps an external price column, preserves SKU and omitted fields, then remembers the next daily upload', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValueOnce(external()).mockResolvedValueOnce(external('$ 1.400,00'))
    const { container } = setup()
    upload(container)
    await screen.findByRole('heading', { name: 'Relacioná tus columnas' })
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeDisabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByLabelText('Columna para Código / SKU'), '0')
    await user.selectOptions(screen.getByLabelText('Columna para Precio de venta'), '3')
    await user.click(screen.getByRole('button', { name: 'Revisar importación' }))
    await screen.findByRole('heading', { name: 'Vista previa' })
    expect(mocks.invoke).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Importar catálogo' }))
    await screen.findByText(/Importación terminada: 0 creados, 1 actualizados/)
    const first = mocks.invoke.mock.calls[0]![1].body
    expect(first.products).toEqual([{ rowRef: '2', code: '000123', name: 'Arroz', category: 'Almacén', basePriceCents: 125050 }])
    expect(first.restaurantId).toBe(commerceA)
    upload(container, 'exportacion (2).xls')
    await screen.findByText(/Reconocimos el formato guardado/)
    expect(screen.getByLabelText('Columna para Precio de venta')).toHaveValue('3')
    await user.click(screen.getByRole('button', { name: 'Revisar importación' }))
    await screen.findByRole('heading', { name: 'Vista previa' })
    await user.click(screen.getByRole('button', { name: 'Importar catálogo' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2))
    const second = mocks.invoke.mock.calls[1]![1].body
    expect(second.batchId).not.toBe(first.batchId)
    expect(second.products[0]).toEqual({ ...first.products[0], basePriceCents: 140000 })
  })

  it('invalidates a prepared snapshot when the user goes back and changes the mapping', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue({ Productos: [['codigo', 'nombre', 'categoria', 'precio', 'Otra lista'], ['A', 'Arroz', 'Almacén', '100', '250']] })
    const { container } = setup()
    upload(container)
    await user.click(await screen.findByRole('button', { name: 'Revisar importación' }))
    await user.click(await screen.findByRole('button', { name: 'Volver a relacionar columnas' }))
    expect(screen.queryByRole('button', { name: 'Importar catálogo' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Columna para Precio de venta'), '4')
    await user.click(screen.getByRole('button', { name: 'Revisar importación' }))
    await user.click(await screen.findByRole('button', { name: 'Importar catálogo' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke.mock.calls[0]![1].body.products[0].basePriceCents).toBe(25000)
  })

  it('ignores an old asynchronous file read after switching commerce', async () => {
    let resolveOld!: (value: Record<string, SheetData>) => void
    mocks.read.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    const view = setup()
    upload(view.container)
    view.switchCommerce(commerceB)
    await act(async () => resolveOld(canonical('Producto de otro comercio')))
    expect(screen.queryByRole('heading', { name: 'Relacioná tus columnas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Importar catálogo' })).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(localStorage.getItem(`catalog-import-profiles:v1:${commerceB}`)).toBeNull()
  })

  it('does not attach an old commerce session after waiting for the submission lock', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValueOnce(canonical('Producto A')).mockResolvedValueOnce(canonical('Producto B'))
    const view = setup()
    upload(view.container)
    await user.click(await screen.findByRole('button', { name: 'Revisar importación' }))
    let release: (() => Promise<void>) | undefined
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, callback: () => unknown) => {
      if (name.startsWith(`catalog-import-submit:${commerceA}:`)) return new Promise((resolve) => { release = async () => { resolve(await callback()) } })
      return Promise.resolve(callback())
    } } })
    await user.click(await screen.findByRole('button', { name: 'Importar catálogo' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    view.switchCommerce(commerceB)
    await act(async () => { await release!() })
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Vista previa' })).not.toBeInTheDocument()
    upload(view.container, 'comercio-b.xlsx')
    await user.click(await screen.findByRole('button', { name: 'Revisar importación' }))
    await user.click(await screen.findByRole('button', { name: 'Importar catálogo' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke.mock.calls[0]![1].body.restaurantId).toBe(commerceB)
    expect(mocks.invoke.mock.calls[0]![1].body.products[0].name).toBe('Producto B')
  })

  it('releases the category column when switching to a fixed category', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue(canonical())
    const { container } = setup()
    upload(container)
    await screen.findByRole('heading', { name: 'Relacioná tus columnas' })
    await user.selectOptions(screen.getByLabelText('Dónde están las categorías'), 'fixed')
    await user.type(screen.getByLabelText('Categoría para todos los productos'), 'General')
    fireEvent.click(screen.getByText('Más campos: descripción, promociones, imágenes y variantes'))
    await user.selectOptions(screen.getByLabelText('Columna para Descripción'), '2')
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Revisar importación' }))
    await user.click(await screen.findByRole('button', { name: 'Importar catálogo' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke.mock.calls[0]![1].body.products[0]).toMatchObject({ category: 'General', description: 'Almacén' })
  })

  it('does not retain a stale preview when the next file is unreadable', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValueOnce(canonical()).mockRejectedValueOnce(new Error('No pudimos abrir la planilla.'))
    const { container } = setup()
    upload(container)
    await user.click(await screen.findByRole('button', { name: 'Revisar importación' }))
    await screen.findByRole('heading', { name: 'Vista previa' })
    upload(container, 'otro.xls')
    await screen.findByText('No pudimos abrir la planilla.')
    expect(screen.queryByRole('button', { name: 'Importar catálogo' })).not.toBeInTheDocument()
  })

  it('requires explicit exclusion of invalid rows and does not remember those exclusions in the profile', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue({ Productos: [...canonical().Productos!, ['B', 'Yerba', 'Almacén', 'sin precio']] })
    const { container } = setup()
    upload(container)
    const review = await screen.findByRole('button', { name: 'Revisar importación' })
    expect(review).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Excluir fila 3' }))
    expect(review).toBeEnabled()
    await user.click(review)
    await screen.findByRole('heading', { name: 'Vista previa' })
    const stored = JSON.parse(localStorage.getItem(`catalog-import-profiles:v1:${commerceA}`)!)
    expect(stored.profiles[0].mapping.skippedRows).toEqual([])
    upload(container, 'nuevo.xls')
    expect(await screen.findByRole('button', { name: 'Revisar importación' })).toBeDisabled()
  })
})
