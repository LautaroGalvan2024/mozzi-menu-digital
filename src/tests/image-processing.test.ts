import { afterEach, describe, expect, it, vi } from 'vitest'
import { processImage } from '../lib/images/processImage'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockBitmap(width: number, height: number) {
  const close = vi.fn()
  const drawImage = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '', fillRect: vi.fn(), drawImage,
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
    callback(new Blob([new Uint8Array(200_000)], { type: 'image/webp' }))
  })
  return { close, drawImage }
}

describe('image processing', () => {
  it('downscales a large image and emits a bounded WebP upload', async () => {
    const { close } = mockBitmap(2400, 1200)

    const result = await processImage(
      new File([new Uint8Array(1_000)], 'foto.jpg', { type: 'image/jpeg' }),
    )

    expect(result.variants.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 320, height: 160 },
      { width: 640, height: 320 },
      { width: 1200, height: 600 },
    ])
    expect(result.width).toBe(1200)
    expect(result.height).toBe(600)
    expect(result.mimeType).toBe('image/webp')
    expect(result.blob.size).toBeLessThanOrEqual(1024 * 1024)
    const baseNames = result.variants.map((variant) => variant.filename.replace(/-(320|640|1200)\.webp$/, ''))
    expect(new Set(baseNames).size).toBe(1)
    expect(result.variants.map((variant) => variant.filename)).toEqual([
      `${baseNames[0]}-320.webp`,
      `${baseNames[0]}-640.webp`,
      `${baseNames[0]}-1200.webp`,
    ])
    expect(close).toHaveBeenCalledOnce()
  })

  it('fits the 485 by 497 portrait within metadata limits without cropping', async () => {
    const { close, drawImage } = mockBitmap(485, 497)
    const result = await processImage(new File(['png'], 'Captura.PNG', { type: 'image/png' }))
    expect(result.variants.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 320, height: 328 }, { width: 640, height: 656 }, { width: 1171, height: 1200 },
    ])
    expect(result.filename).toMatch(/-w1171-1171\.webp$/)
    for (const variant of result.variants) {
      expect(variant.filename).toMatch(new RegExp(`-w1171-${variant.width}\\.webp$`))
      expect(variant.blob.size).toBeLessThanOrEqual(1024 * 1024)
    }
    expect(drawImage.mock.calls).toEqual([
      [expect.anything(), 0, 0, 320, 328], [expect.anything(), 0, 0, 640, 656], [expect.anything(), 0, 0, 1171, 1200],
    ])
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    { width: 200, height: 600, expected: [{ width: 320, height: 960 }, { width: 400, height: 1200 }] },
    { width: 100, height: 2000, expected: [{ width: 60, height: 1200 }] },
    { width: 1, height: 2000, expected: [{ width: 1, height: 1200 }] },
  ])('deduplicates bounded variants for $width by $height images', async ({ width, height, expected }) => {
    mockBitmap(width, height)
    const result = await processImage(new File(['png'], 'portrait.png', { type: 'image/png' }))
    expect(result.variants.map(({ width, height }) => ({ width, height }))).toEqual(expected)
    expect(new Set(result.variants.map(variant => variant.filename)).size).toBe(expected.length)
    expect(result.filename).toMatch(new RegExp(`-w${result.width}-${result.width}\\.webp$`))
  })

  it('preserves the existing square image sizes and names', async () => {
    mockBitmap(500, 500)
    const result = await processImage(new File(['png'], 'logo.png', { type: 'image/png' }))
    expect(result.variants.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 320, height: 320 }, { width: 640, height: 640 }, { width: 1200, height: 1200 },
    ])
    expect(result.filename).toMatch(/-1200\.webp$/)
    expect(result.filename).not.toContain('-w1200')
  })
})
