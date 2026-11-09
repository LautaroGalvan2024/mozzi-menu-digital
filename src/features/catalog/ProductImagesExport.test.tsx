import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductImagesExport } from './ProductImagesExport'

const mocks = vi.hoisted(() => ({ choose: vi.fn(), read: vi.fn(), write: vi.fn(), abort: vi.fn(), finish: vi.fn() }))
vi.mock('../../lib/images/zip-destination', () => ({ chooseZipDestination: mocks.choose }))
vi.mock('../../lib/images/catalog-export', () => ({ readImageCatalog: mocks.read, writeImageArchive: mocks.write }))
const restaurantId = '10000000-0000-4000-8000-000000000000'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.choose.mockResolvedValue({ mode: 'file', writable: {}, abort: mocks.abort, finish: mocks.finish })
  mocks.finish.mockResolvedValue(null)
  mocks.abort.mockResolvedValue(undefined)
  mocks.read.mockResolvedValue([{ id: 'p', image_path: 'image.webp' }])
  mocks.write.mockResolvedValue({ products: [{}], missingImages: [], errors: [] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('product images export control', () => {
  it('downloads the whole selected commerce through the shared writer', async () => {
    render(<ProductImagesExport restaurantId={restaurantId} />)
    await userEvent.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    await screen.findByText('1 imágenes guardadas. 0 productos sin imagen.')
    expect(mocks.read).toHaveBeenCalledWith(restaurantId, expect.any(AbortSignal))
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ restaurantId, products: [{ id: 'p', image_path: 'image.webp' }] }))
  })

  it('reports incomplete downloads explicitly', async () => {
    mocks.write.mockResolvedValue({ products: [{}], missingImages: [{}], errors: [{}] })
    render(<ProductImagesExport restaurantId={restaurantId} />)
    await userEvent.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Descarga incompleta')
    expect(screen.getByRole('alert')).toHaveTextContent('1 imágenes fallaron')
  })

  it('aborts an export when the commerce changes/unmounts', async () => {
    let signal: AbortSignal | undefined
    mocks.read.mockImplementation((_id: string, readSignal: AbortSignal) => {
      signal = readSignal
      return new Promise((_resolve, reject) => readSignal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
    })
    const view = render(<ProductImagesExport restaurantId={restaurantId} />)
    await userEvent.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    await waitFor(() => expect(mocks.read).toHaveBeenCalled())
    view.unmount()
    await waitFor(() => expect(mocks.abort).toHaveBeenCalled())
    expect(signal?.aborted).toBe(true)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('shows live progress and lets the user cancel from the compact feedback area', async () => {
    mocks.write.mockImplementation(({ onProgress, signal }: { onProgress: (value: { current: number, total: number, label: string }) => void, signal: AbortSignal }) => {
      onProgress({ current: 1, total: 2, label: 'Comprimiendo imágenes…' })
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
    })
    render(<ProductImagesExport restaurantId={restaurantId} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Comprimiendo imágenes… · 1/2')
    await user.click(screen.getByRole('button', { name: 'Cancelar descarga' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Descarga cancelada')
    expect(mocks.abort).toHaveBeenCalled()
  })

  it('does not produce an empty ZIP for products without images', async () => {
    mocks.read.mockResolvedValue([{ id: 'p', image_path: null }])
    render(<ProductImagesExport restaurantId={restaurantId} />)
    await userEvent.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    await screen.findByText('No hay imágenes para descargar. 1 productos sin imagen.')
    expect(mocks.abort).toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('releases the previous download URL before preparing another memory-backed ZIP', async () => {
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    mocks.finish.mockResolvedValue(new Blob(['zip']))
    const view = render(<ProductImagesExport restaurantId={restaurantId} />)
    await userEvent.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: 'Descargar imágenes' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2))
    expect(revokeObjectURL.mock.calls).toEqual([['blob:first']])
    view.unmount()
    expect(revokeObjectURL.mock.calls).toEqual([['blob:first'], ['blob:second']])
  })
})
