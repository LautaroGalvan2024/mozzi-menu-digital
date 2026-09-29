import { afterEach, describe, expect, it, vi } from 'vitest'
import { processImage } from '../lib/images/processImage'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('image processing', () => {
  it('downscales a large image and emits a bounded WebP upload', async () => {
    const close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 2400, height: 1200, close }),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array(200_000)], { type: 'image/webp' }))
    })

    const result = await processImage(
      new File([new Uint8Array(1_000)], 'foto.jpg', { type: 'image/jpeg' }),
    )

    expect(result.width).toBe(1200)
    expect(result.height).toBe(600)
    expect(result.mimeType).toBe('image/webp')
    expect(result.blob.size).toBeLessThanOrEqual(1024 * 1024)
    expect(result.filename).toMatch(/\.webp$/)
    expect(close).toHaveBeenCalledOnce()
  })
})
