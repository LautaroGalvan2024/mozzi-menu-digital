import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetData } from 'read-excel-file/browser'
import { ImportProductsPage } from './ImportProductsPage'

const commerceA = '10000000-0000-4000-8000-000000000001'
const commerceB = '10000000-0000-4000-8000-000000000002'
const mocks = vi.hoisted(() => ({ read: vi.fn(), invoke: vi.fn(), rpc: vi.fn(), loadCatalog: vi.fn(), selectedId: '10000000-0000-4000-8000-000000000001', assistedImport: true }))
vi.mock('../../lib/import-file', () => ({ readImportFile: mocks.read, MAX_SPREADSHEET_BYTES: 10 * 1024 * 1024 }))
vi.mock('../../lib/import-review', async importActual => ({ ...await importActual<typeof import('../../lib/import-review')>(), loadImportCatalog: mocks.loadCatalog }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc } }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: mocks.selectedId } }) }))
vi.mock('../restaurants/stage-one-features', () => ({ useStageOneFeatures: () => ({ features: { assisted_import: mocks.assistedImport } }) }))

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
  mocks.assistedImport = true
  mocks.read.mockReset()
  mocks.loadCatalog.mockReset().mockResolvedValue([])
  mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null })
  mocks.invoke.mockReset().mockImplementation((_name, request) => Promise.resolve({ data: {
    batchId: request.body.batchId,
    summary: { created: 0, updated: request.body.products.length, skipped: 0 }, errors: [],
    products: request.body.products.map((product: { rowRef: string; code: string }, index: number) => ({ rowRef: product.rowRef, code: product.code, id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, outcome: 'updated' })),
  }, error: null }))
})
afterEach(cleanup)

describe('flexible import review', () => {
  it('keeps manual mapping and confirmation usable without catalog preflight for a commerce outside the pilot', async () => {
    mocks.assistedImport = false
    mocks.read.mockResolvedValue(canonical())
    const { container } = setup()
    upload(container)
    expect(await screen.findByRole('heading', { name: 'Relacioná tus columnas' })).toBeVisible()
    expect(screen.getByLabelText('Columna para Nombre')).toBeVisible()
    expect(screen.queryByLabelText('Resultado previsto de la importación')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Revisar importación' }))
    expect(await screen.findByRole('heading', { name: 'Vista previa' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Importar catálogo' })).toBeEnabled()
    expect(mocks.loadCatalog).not.toHaveBeenCalled()
  })

  it('starts with a concise summary and verified create/update counts for a recognized file', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue({ Productos: [...canonical().Productos!, ['B', 'Yerba', 'Almacén', '900']] })
    mocks.loadCatalog.mockResolvedValue([{ id: '20000000-0000-4000-8000-000000000001', restaurant_id: commerceA, code: '000123', deleted_at: null }])
    const { container } = setup()
    upload(container)
    await screen.findByRole('heading', { name: 'Resumen del archivo' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeEnabled())
    expect(screen.queryByRole('heading', { name: 'Relacioná tus columnas' })).not.toBeInTheDocument()
    const summary = within(screen.getByLabelText('Resultado previsto de la importación'))
    expect(summary.getByText('para crear')).toHaveTextContent('1para crear')
    expect(summary.getByText('para actualizar')).toHaveTextContent('1para actualizar')
    expect(summary.getByText('filas para revisar')).toHaveTextContent('0filas para revisar')
    expect(mocks.loadCatalog).toHaveBeenCalledWith(commerceA, expect.any(AbortSignal))
    expect(mocks.invoke).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cambiar columnas' }))
    expect(screen.getByRole('heading', { name: 'Relacioná tus columnas' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Ocultar configuración de columnas' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps counts unknown on lookup failure and retries without submitting the catalog', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue(canonical())
    mocks.loadCatalog.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
    const { container } = setup()
    upload(container)
    await screen.findByText(/No pudimos comprobar los códigos/)
    const summary = within(screen.getByLabelText('Resultado previsto de la importación'))
    expect(summary.getByText('para crear')).toHaveTextContent('—para crear')
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reintentar comprobación' }))
    await waitFor(() => expect(summary.getByText('para crear')).toHaveTextContent('1para crear'))
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeEnabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('keeps optional missing SKUs in the summary and still requires explicit confirmation before creating them', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue({ Productos: [['nombre', 'categoria', 'precio'], ['Nuevo producto', 'General', '100']] })
    const { container } = setup()
    upload(container)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Cambiar columnas' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'Revisar importación' }))
    await screen.findByRole('heading', { name: 'Vista previa' })
    expect(screen.getByRole('button', { name: 'Importar catálogo' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /Entiendo que las filas sin código/ }))
    expect(screen.getByRole('button', { name: 'Importar catálogo' })).toBeEnabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('updates counts and shows only conflicting rows when the import mode changes', async () => {
    const user = userEvent.setup()
    mocks.read.mockResolvedValue({ Productos: [...canonical().Productos!, ['B', 'Yerba', 'Almacén', '900']] })
    mocks.loadCatalog.mockResolvedValue([{ id: '20000000-0000-4000-8000-000000000001', restaurant_id: commerceA, code: '000123', deleted_at: null }])
    const { container } = setup()
    upload(container)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeEnabled())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cómo importar' }), 'create_only')
    expect(screen.getByText(/El producto ya existe/)).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Filas del archivo' })).toHaveValue('issues')
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeDisabled()
    expect(within(screen.getByLabelText('Resultado previsto de la importación')).getByText('filas para revisar')).toHaveTextContent('1filas para revisar')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cómo importar' }), 'skip_existing')
    expect(within(screen.getByLabelText('Resultado previsto de la importación')).getByText('existentes que se omitirán')).toHaveTextContent('1existentes que se omitirán')
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeEnabled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('does not expose an old tenant lookup when the commerce changes', async () => {
    let resolveCatalog!: (value: unknown) => void
    mocks.read.mockResolvedValue(canonical())
    mocks.loadCatalog.mockReturnValueOnce(new Promise(resolve => { resolveCatalog = resolve }))
    const view = setup()
    upload(view.container)
    await screen.findByText('Comprobando códigos con el catálogo del comercio…')
    view.switchCommerce(commerceB)
    await act(async () => resolveCatalog([{ id: '20000000-0000-4000-8000-000000000001', restaurant_id: commerceA, code: '000123', deleted_at: null }]))
    expect(screen.queryByLabelText('Resultado previsto de la importación')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Importar catálogo' })).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

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
    await user.click(await screen.findByRole('button', { name: 'Cambiar columnas' }))
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
