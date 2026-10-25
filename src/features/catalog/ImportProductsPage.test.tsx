import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportProductsPage } from './ImportProductsPage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  storageFrom: vi.fn(),
  processImage: vi.fn(),
  uploadImage: vi.fn(),
  loadZip: vi.fn(),
  parseImportSheets: vi.fn(),
  readXlsxFile: vi.fn(),
}))

vi.mock('jszip', () => ({
  default: { loadAsync: mocks.loadZip },
}))

vi.mock('read-excel-file/browser', () => ({
  default: mocks.readXlsxFile,
}))

vi.mock('../../lib/import-products', () => ({
  csvRecordsToSheet: vi.fn(),
  parseImportSheets: mocks.parseImportSheets,
}))

vi.mock('../../lib/images/processImage', () => ({
  processImage: mocks.processImage,
}))

vi.mock('../../lib/images/upload', () => ({
  uploadRestaurantImage: mocks.uploadImage,
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    rpc: mocks.rpc,
    from: mocks.from,
    storage: { from: mocks.storageFrom },
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

const parsedImport = {
  products: [{
    rowRef: '2',
    code: 'P-1',
    name: 'Milanesa',
    description: '',
    category: 'Platos',
    basePriceCents: 120000,
    promotionalPriceCents: null,
    promotionStartsAt: null,
    promotionEndsAt: null,
    active: true,
    available: true,
    featured: false,
    sortOrder: 0,
    imageFilename: 'milanesa.jpg',
  }],
  groups: [],
  options: [],
  errors: [],
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportProductsPage />
    </QueryClientProvider>,
  )
}

describe('catalog import file state', () => {
  afterEach(cleanup)

  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => Promise.resolve(callback()) } })
    mocks.invoke.mockReset()
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: null })
    mocks.from.mockReset()
    mocks.storageFrom.mockReset()
    mocks.processImage.mockReset()
    mocks.uploadImage.mockReset()
    mocks.loadZip.mockReset()
    mocks.parseImportSheets.mockReset().mockReturnValue(parsedImport)
    mocks.readXlsxFile.mockReset().mockResolvedValue([{ sheet: 'Productos', data: [] }])
  })

  it('reuses the persisted batch after an ambiguous reply and a null recovery', async () => {
    const user = userEvent.setup()
    mocks.parseImportSheets.mockReturnValue({ ...parsedImport, products: parsedImport.products.map(({ code: _code, imageFilename: _image, ...product }) => product) })
    mocks.invoke.mockRejectedValueOnce(new Error('connection lost')).mockImplementationOnce((_name, request) => Promise.resolve({ data: {
      batchId: request.body.batchId, summary: { created: 1, updated: 0, skipped: 0 }, errors: [],
      products: [{ rowRef: '2', id: '10000000-0000-4000-8000-000000000002', code: 'P-000001', outcome: 'created' }],
    }, error: null }))
    const { container } = renderPage()
    fireEvent.change(container.querySelector<HTMLInputElement>('input[accept^=".xlsx"]')!, { target: { files: [new File(['workbook'], 'catalogo.xlsx')] } })
    expect(await screen.findByText(/1 filas sin código ni identificador/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Importar catálogo' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Conservamos el mismo lote')
    const firstBody = mocks.invoke.mock.calls[0]![1].body
    expect(firstBody.batchId).toMatch(/^[0-9a-f-]{36}$/)
    await user.click(screen.getByRole('button', { name: 'Recuperar o continuar importación' }))
    expect(await screen.findByText(/Importación terminada: 1 creados/)).toBeVisible()
    expect(mocks.invoke.mock.calls[1]![1].body).toEqual(firstBody)
    expect(mocks.rpc).toHaveBeenCalledWith('get_catalog_import_result', { p_restaurant_id: firstBody.restaurantId, p_batch_id: firstBody.batchId })
    expect(screen.getByRole('button', { name: 'Descargar resultado' })).toBeVisible()
  })

  it('restores a completed result after remount and never reinvokes metadata on replay', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation((_name, request) => Promise.resolve({ data: {
      batchId: request.body.batchId, summary: { created: 1, updated: 0, skipped: 0 }, errors: [],
      products: [{ rowRef: '2', id: '10000000-0000-4000-8000-000000000002', code: 'P-1', outcome: 'created' }],
    }, error: null }))
    const { container, unmount } = renderPage()
    fireEvent.change(container.querySelector<HTMLInputElement>('input[accept^=".xlsx"]')!, { target: { files: [new File(['workbook'], 'catalogo.xlsx')] } })
    await screen.findByRole('heading', { name: 'Vista previa' })
    await user.click(screen.getByRole('button', { name: 'Importar catálogo' }))
    await screen.findByText(/Importación terminada: 1 creados/)
    const response = (await mocks.invoke.mock.results[0]!.value).data
    mocks.rpc.mockResolvedValue({ data: response, error: null })
    unmount()
    renderPage()
    expect(await screen.findByRole('button', { name: 'Descargar resultado' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Recuperar o continuar importación' }))
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('reconciles a committed image after a lost reply without deleting or uploading again', async () => {
    const user = userEvent.setup()
    const productId = '10000000-0000-4000-8000-000000000002'
    mocks.invoke.mockImplementation((_name, request) => Promise.resolve({ data: {
      batchId: request.body.batchId, summary: { created: 1, updated: 0, skipped: 0 }, errors: [],
      products: [{ rowRef: '2', id: productId, code: 'P-1', outcome: 'created' }],
    }, error: null }))
    mocks.loadZip.mockResolvedValue({ file: () => ({ dir: false, async: () => Promise.resolve(new Uint8Array([1])) }) })
    mocks.processImage.mockResolvedValue({ filename: 'new.webp' })
    mocks.uploadImage.mockResolvedValue('restaurants/test/products/new.webp')
    const list = { select: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [{ id: productId, image_path: null }], error: null }) }
    const update = { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'reply lost' } }) }
    const check = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { image_path: 'restaurants/test/products/new.webp' }, error: null }) }
    mocks.from.mockReturnValueOnce(list).mockReturnValueOnce(update).mockReturnValueOnce(check)
    const { container } = renderPage()
    fireEvent.change(container.querySelector<HTMLInputElement>('input[accept^=".xlsx"]')!, { target: { files: [new File(['workbook'], 'catalogo.xlsx')] } })
    await screen.findByRole('heading', { name: 'Vista previa' })
    fireEvent.change(container.querySelector<HTMLInputElement>('input[accept^=".zip"]')!, { target: { files: [new File(['zip'], 'images.zip')] } })
    await user.click(screen.getByRole('button', { name: 'Importar catálogo' }))
    await waitFor(() => expect(check.single).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continuar imágenes pendientes' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Continuar imágenes pendientes' }))
    expect(mocks.uploadImage).toHaveBeenCalledTimes(1)
    expect(mocks.storageFrom).not.toHaveBeenCalled()
    expect(update.is).toHaveBeenCalledWith('image_path', null)
  })

  it('clears the prior preview before rejecting a new oversized spreadsheet', async () => {
    const { container } = renderPage()
    const spreadsheetInput = container.querySelector<HTMLInputElement>('input[accept^=".xlsx"]')
    expect(spreadsheetInput).not.toBeNull()

    fireEvent.change(spreadsheetInput!, {
      target: { files: [new File(['workbook'], 'catalogo.xlsx')] },
    })
    expect(await screen.findByRole('heading', { name: 'Vista previa' })).toBeVisible()
    expect(screen.getByText('catalogo.xlsx')).toBeVisible()

    const oversized = new File(['x'], 'catalogo-nuevo.xlsx')
    Object.defineProperty(oversized, 'size', { value: 10 * 1024 * 1024 + 1 })
    fireEvent.change(spreadsheetInput!, { target: { files: [oversized] } })

    expect(screen.queryByRole('heading', { name: 'Vista previa' })).not.toBeInTheDocument()
    expect(screen.queryByText('catalogo.xlsx')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('supera el límite de 10 MB')
  })

  it('rejects an unreadable ZIP before invoking the metadata import', async () => {
    const user = userEvent.setup()
    mocks.loadZip.mockRejectedValue(new Error('invalid zip'))
    const { container } = renderPage()
    const spreadsheetInput = container.querySelector<HTMLInputElement>('input[accept^=".xlsx"]')
    const zipInput = container.querySelector<HTMLInputElement>('input[accept^=".zip"]')

    fireEvent.change(spreadsheetInput!, {
      target: { files: [new File(['workbook'], 'catalogo.xlsx')] },
    })
    expect(await screen.findByRole('heading', { name: 'Vista previa' })).toBeVisible()
    fireEvent.change(zipInput!, {
      target: { files: [new File(['not-a-zip'], 'imagenes.zip', { type: 'application/zip' })] },
    })
    await user.click(screen.getByRole('button', { name: 'Importar catálogo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos abrir el ZIP de imágenes. La metadata no fue importada.',
    )
    await waitFor(() => expect(mocks.invoke).not.toHaveBeenCalled())
  })
})
