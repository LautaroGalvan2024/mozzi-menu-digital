import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportProductsPage } from './ImportProductsPage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
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
  processImage: vi.fn(),
}))

vi.mock('../../lib/images/upload', () => ({
  uploadRestaurantImage: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    from: vi.fn(),
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

const parsedImport = {
  products: [{
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
    mocks.invoke.mockReset()
    mocks.loadZip.mockReset()
    mocks.parseImportSheets.mockReset().mockReturnValue(parsedImport)
    mocks.readXlsxFile.mockReset().mockResolvedValue([{ sheet: 'Productos', data: [] }])
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
