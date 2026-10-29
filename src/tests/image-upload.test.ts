import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessedImage, ProcessedImageVariant } from '../lib/images/processImage'
import { uploadRestaurantImage } from '../lib/images/upload'

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  insert: vi.fn(),
  getUser: vi.fn(),
}))

vi.mock('../lib/supabase/client', () => ({
  supabase: {
    storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove }) },
    auth: { getUser: mocks.getUser },
    from: () => ({ insert: mocks.insert }),
  },
}))

const variant = (width: number): ProcessedImageVariant => ({
  blob: new Blob([`${width}`], { type: 'image/webp' }),
  width,
  height: width,
  filename: `asset-${width}.webp`,
  mimeType: 'image/webp',
})

const variants = [variant(320), variant(640), variant(1200)]
const image: ProcessedImage = { ...variants[2]!, variants }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.upload.mockResolvedValue({ error: null })
  mocks.remove.mockResolvedValue({ error: null })
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'actor-id' } } })
  mocks.insert.mockResolvedValue({ error: null })
})

describe('responsive image upload', () => {
  it('uploads and records every size while returning the 1200px primary path', async () => {
    const primaryPath = await uploadRestaurantImage({
      restaurantId: 'restaurant-id',
      kind: 'products',
      entityId: 'product-id',
      image,
    })

    expect(mocks.upload).toHaveBeenCalledTimes(3)
    expect(mocks.insert).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/asset-320\.webp$/), width: 320 }),
      expect.objectContaining({ path: expect.stringMatching(/asset-640\.webp$/), width: 640 }),
      expect.objectContaining({ path: expect.stringMatching(/asset-1200\.webp$/), width: 1200 }),
    ]))
    expect(primaryPath).toMatch(/asset-1200\.webp$/)
  })

  it('rolls back earlier variants if a later upload fails', async () => {
    mocks.upload
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: new Error('storage unavailable') })

    await expect(uploadRestaurantImage({
      restaurantId: 'restaurant-id',
      kind: 'cover',
      image,
    })).rejects.toThrow('No se pudo subir la imagen.')

    expect(mocks.remove).toHaveBeenCalledWith([
      'restaurants/restaurant-id/cover/asset-320.webp',
    ])
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
