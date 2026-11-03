// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { collectImageCatalog, imageExportFilename, readImageCatalog, writeImageArchive, type ImageExportProduct } from '../lib/images/catalog-export'
import { memoryZipDestination } from '../lib/images/zip-destination'

const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../lib/supabase/client', () => ({ supabase: { from: mocks.from } }))
vi.mock('../lib/supabase/public-assets', () => ({ publicAssetUrl: (path: string) => `https://assets.invalid/${path}` }))

const restaurantId = '10000000-0000-4000-8000-000000000000'
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR/8AAAAASUVORK5CYII=', 'base64'))
function product(index: number, hasImage = true): ImageExportProduct {
  const id = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return { id, name: `Producto ${index}`, code: `00${index}`, image_path: hasImage ? `restaurants/${restaurantId}/products/${id}/image.png` : null }
}

describe('whole-catalog image export', () => {
  it.each([0, 10, 51, 1001, 5000])('reads and exports %i products beyond the visible page, with a valid manifest and CRC', async count => {
    const source = Array.from({ length: count }, (_, index) => product(index))
    const readPage = vi.fn(async (after: string | null) => source.filter(row => after === null || row.id > after).slice(0, 37))
    const signal = new AbortController().signal
    const products = await collectImageCatalog(readPage, signal)
    expect(products).toEqual(source)
    expect(readPage).toHaveBeenCalledTimes(Math.ceil(count / 37) + 1)
    const destination = memoryZipDestination()
    const manifest = await writeImageArchive({ restaurantId, products, writable: destination.writable, signal, onProgress: vi.fn(), readImage: async () => png })
    const blob = (await destination.finish())!
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true })
    expect(manifest.products).toHaveLength(count)
    expect(Object.keys(zip.files)).toHaveLength(count + 1)
    expect(JSON.parse(await zip.file('images-manifest.json')!.async('text'))).toEqual(manifest)
    if (count) expect(await zip.file(manifest.products.at(-1)!.path)!.async('uint8array')).toEqual(png)
  }, 30_000)

  it('scopes each database page to its commerce, includes hidden/out-of-stock products and excludes deleted ones', async () => {
    const rows = [product(1), product(2, false)]
    const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(), gt: vi.fn(), then: vi.fn() }
    for (const name of ['select', 'eq', 'is', 'order', 'limit', 'abortSignal', 'gt'] as const) query[name].mockReturnValue(query)
    let calls = 0
    query.then.mockImplementation((resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: calls++ === 0 ? rows : [], error: null })))
    mocks.from.mockReturnValue(query)
    const result = await readImageCatalog(restaurantId, new AbortController().signal)
    expect(result).toEqual(rows)
    expect(query.eq).toHaveBeenCalledWith('restaurant_id', restaurantId)
    expect(query.eq).toHaveBeenCalledTimes(2)
    expect(query.is).toHaveBeenCalledWith('deleted_at', null)
    expect(query.gt).toHaveBeenCalledWith('id', rows[1]!.id)
    expect(query.limit).toHaveBeenCalledWith(500)
  })

  it('keeps at most three image downloads active and reports failures without corrupting subsequent entries', async () => {
    const products = Array.from({ length: 10 }, (_, index) => product(index, index !== 9))
    let active = 0
    let maximum = 0
    const destination = memoryZipDestination()
    const manifest = await writeImageArchive({ restaurantId, products, writable: destination.writable, signal: new AbortController().signal, onProgress: vi.fn(), readImage: async row => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      if (row.id === products[3]!.id) throw new Error('HTTP 404')
      return png
    } })
    expect(maximum).toBe(3)
    expect(manifest.products).toHaveLength(8)
    expect(manifest.missingImages).toEqual([{ productId: products[9]!.id, sku: products[9]!.code }])
    expect(manifest.errors).toEqual([{ productId: products[3]!.id, sku: products[3]!.code, message: 'HTTP 404' }])
    const zip = await JSZip.loadAsync(await (await destination.finish())!.arrayBuffer(), { checkCRC32: true })
    expect(zip.file(manifest.products.at(-1)!.path)).not.toBeNull()
  })

  it('cancels queued downloads and does not finish an archive after cancellation', async () => {
    const abort = new AbortController()
    const destination = memoryZipDestination()
    const readImage = vi.fn(async () => png)
    await expect(writeImageArchive({ restaurantId, products: Array.from({ length: 10 }, (_, index) => product(index)), writable: destination.writable, signal: abort.signal, onProgress: () => abort.abort(), readImage })).rejects.toThrow()
    expect(readImage.mock.calls.length).toBeLessThanOrEqual(4)
    await destination.abort()
  })

  it('rejects unsafe or foreign image paths without issuing a fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const destination = memoryZipDestination()
    const manifest = await writeImageArchive({ restaurantId, products: [{ ...product(1), image_path: 'restaurants/other/products/image.png' }], writable: destination.writable, signal: new AbortController().signal, onProgress: vi.fn() })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(manifest.errors[0]?.message).toContain('no pertenece')
    vi.unstubAllGlobals()
  })

  it('prevents filename collisions and path traversal for arbitrary product names/SKUs', () => {
    const first = { ...product(1), code: '../x/y', name: '../../Mismo\\nombre' }
    const second = { ...first, id: product(2).id }
    const filename = imageExportFilename(first, 'png')
    expect(filename).not.toMatch(/[\\/]/)
    expect(filename).not.toContain('..')
    expect(filename).not.toEqual(imageExportFilename(second, 'png'))
  })

  it('bounds the memory-only fallback without splitting or silently truncating the archive', async () => {
    const destination = memoryZipDestination(100)
    await expect(writeImageArchive({ restaurantId, products: [product(1)], writable: destination.writable, signal: new AbortController().signal, onProgress: vi.fn(), readImage: async () => png })).rejects.toThrow('250 MB')
    await destination.abort()
  })
})
