import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadImageBatch, loadImageProducts } from '../lib/images/import-image-batch'
import type { ImageArchive } from '../lib/images/image-archive'
import type { ImportImageAttempt } from '../lib/import-session'

const mocks = vi.hoisted(() => ({ from: vi.fn(), process: vi.fn(), upload: vi.fn(), file: vi.fn() }))
vi.mock('../lib/supabase/client', () => ({ supabase: { from: mocks.from } }))
vi.mock('../lib/images/processImage', () => ({ processImage: mocks.process }))
vi.mock('../lib/images/upload', () => ({ uploadRestaurantImage: mocks.upload }))
vi.mock('../lib/images/image-archive', () => ({ archiveImageFile: mocks.file }))
const tenant = '10000000-0000-4000-8000-000000000001'
const productId = '20000000-0000-4000-8000-000000000001'
const target = { key: 'photo.png', filename: 'photo.png', productId, expectedPath: null }
const archive = {} as ImageArchive
function request(data: unknown, error: unknown = null) {
  const response = { data, error }
  return { select: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), gt: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue(response), single: vi.fn().mockResolvedValue(response), then: (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve) }
}
describe('shared image upload executor', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.file.mockResolvedValue(new File(['x'], 'photo.png', { type: 'image/png' }))
    mocks.process.mockResolvedValue({ filename: 'new.webp' })
    mocks.upload.mockResolvedValue('new.webp')
  })
  it('persists an upload before CAS association, with tenant and non-deleted filters', async () => {
    const read = request([{ id: productId, image_path: null }]); const update = request({ id: productId })
    mocks.from.mockReturnValueOnce(read).mockReturnValueOnce(update)
    const attempts: Record<string, ImportImageAttempt> = {}
    const persisted: unknown[] = []
    const errors = await uploadImageBatch({ restaurantId: tenant, archive, targets: [target], attempts, persist: async () => { persisted.push(structuredClone(attempts)) } })
    expect(errors).toEqual([])
    expect(persisted).toEqual([{ 'photo.png': { path: 'new.webp', expectedPath: null, associated: false } }, { 'photo.png': { path: 'new.webp', expectedPath: null, associated: true } }])
    expect(update.eq).toHaveBeenCalledWith('restaurant_id', tenant)
    expect(update.is).toHaveBeenCalledWith('deleted_at', null)
    expect(update.is).toHaveBeenCalledWith('image_path', null)
  })
  it('rejects a changed image from the preview without uploading or overwriting', async () => {
    mocks.from.mockReturnValue(request([{ id: productId, image_path: 'someone-else.webp' }]))
    const errors = await uploadImageBatch({ restaurantId: tenant, archive, targets: [target], attempts: {}, persist: async () => undefined })
    expect(errors[0]?.message).toMatch(/cambió después/)
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.from).toHaveBeenCalledTimes(1)
  })
  it('reconciles a committed image after a lost reply without repeating uploads', async () => {
    mocks.from.mockReturnValue(request([{ id: productId, image_path: 'new.webp' }]))
    const attempts = { 'photo.png': { path: 'new.webp', expectedPath: null, associated: false } }
    expect(await uploadImageBatch({ restaurantId: tenant, archive, targets: [target], attempts, persist: async () => undefined })).toEqual([])
    expect(attempts['photo.png'].associated).toBe(true)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('retries only association when the previous uploaded path is still pending', async () => {
    mocks.from.mockReturnValueOnce(request([{ id: productId, image_path: null }])).mockReturnValueOnce(request({ id: productId }))
    const attempts = { 'photo.png': { path: 'new.webp', expectedPath: null, associated: false } }
    expect(await uploadImageBatch({ restaurantId: tenant, archive, targets: [target], attempts, persist: async () => undefined })).toEqual([])
    expect(mocks.process).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('does no writes when ownership cannot be read or the operation is cancelled', async () => {
    mocks.from.mockReturnValue(request(null, { message: 'offline' }))
    await expect(uploadImageBatch({ restaurantId: tenant, archive, targets: [target], attempts: {}, persist: async () => undefined })).rejects.toThrow(/consultar/)
    mocks.from.mockReturnValue(request([{ id: productId, image_path: null }]))
    expect(await uploadImageBatch({ restaurantId: tenant, archive, targets: [target], attempts: {}, persist: async () => undefined, isCurrent: () => false })).toEqual([])
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('reads all product pages by cursor within the selected tenant', async () => {
    const products = Array.from({ length: 501 }, (_, index) => ({ id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, code: `SKU${index}`, name: `P${index}`, image_path: null }))
    const first = request(products.slice(0, 500)); const second = request(products.slice(500))
    mocks.from.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(request([]))
    expect(await loadImageProducts(tenant)).toHaveLength(501)
    expect(first.eq).toHaveBeenCalledWith('restaurant_id', tenant)
    expect(second.gt).toHaveBeenCalledWith('id', products[499]!.id)
  })
})
