import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportImagesPanel } from './ImportImagesPanel'
import type { ImageArchive } from '../../lib/images/image-archive'

const mocks = vi.hoisted(() => ({ read: vi.fn(), products: vi.fn(), upload: vi.fn() }))
vi.mock('../../lib/images/image-archive', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/images/image-archive')>(), readImageArchive: mocks.read }))
vi.mock('../../lib/images/import-image-batch', () => ({ loadImageProducts: mocks.products, uploadImageBatch: mocks.upload }))
const tenant = '10000000-0000-4000-8000-000000000001'
const product = { id: '20000000-0000-4000-8000-000000000001', code: '000123', name: 'Yerba', image_path: null }
const zip: ImageArchive = { fingerprint: 'a'.repeat(64), fileName: 'photos.zip', files: ['000123_yerba.png', 'foto.png'], ignored: [], entries: new Map(), manifest: null }
function page(id = tenant) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ImportImagesPanel restaurantId={id} onBusyChange={() => undefined}/></QueryClientProvider>)
}
async function choose() { fireEvent.change(screen.getByLabelText('ZIP para actualizar imágenes'), { target: { files: [new File(['zip'], 'photos.zip')] } }); await screen.findByText(/2 imágenes ·/) }
describe('ZIP-only image review', () => {
  afterEach(cleanup)
  beforeEach(() => {
    localStorage.clear(); vi.resetAllMocks()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => Promise.resolve(callback()) } })
    mocks.read.mockResolvedValue(zip); mocks.products.mockResolvedValue([product]); mocks.upload.mockResolvedValue([])
  })
  it('requires explicit resolution or exclusion and blocks duplicate target products', async () => {
    page(); await choose()
    expect(screen.getByRole('button', { name: 'Guardar imágenes' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('SKU para foto.png'), { target: { value: '000123' } })
    expect(screen.getAllByText('Hay más de una imagen asignada a este producto.')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Guardar imágenes' })).toBeDisabled()
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Excluir' })[1]!)
    expect(screen.getByRole('button', { name: 'Guardar imágenes' })).toBeEnabled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('stores only image targets and recovers the same pending operation after remount', async () => {
    const view = page(); await choose()
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Excluir' })[1]!)
    mocks.upload.mockImplementation(async (options: { targets: unknown[]; attempts: Record<string, unknown>; persist: () => Promise<unknown> }) => {
      options.attempts['000123_yerba.png'] = { path: 'new.webp', expectedPath: null, associated: true }
      await options.persist(); return []
    })
    await userEvent.click(screen.getByRole('button', { name: 'Guardar imágenes' }))
    await screen.findByText(/1 imágenes guardadas/)
    const expectedFilename = zip.files[0]!
    expect(mocks.upload.mock.calls[0]?.[0].targets).toEqual([{ key: expectedFilename, filename: expectedFilename, productId: product.id, expectedPath: null }])
    const firstId = JSON.parse(localStorage.getItem(`catalog-image-import:v1:${tenant}`)!).latest
    view.unmount(); page()
    expect(screen.getByText(/Hay una carga guardada/)).toBeVisible()
    await choose()
    expect(screen.getByRole('button', { name: 'Continuar imágenes pendientes' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Continuar imágenes pendientes' }))
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2))
    expect(JSON.parse(localStorage.getItem(`catalog-image-import:v1:${tenant}`)!).latest).toBe(firstId)
  })
  it('rejects a ZIP manifest from a different commerce before offering assignments', async () => {
    mocks.read.mockResolvedValue({ ...zip, manifest: { version: 1, restaurantId: '10000000-0000-4000-8000-000000000099', products: [] } })
    page()
    fireEvent.change(screen.getByLabelText('ZIP para actualizar imágenes'), { target: { files: [new File(['zip'], 'photos.zip')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('otro comercio')
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})
