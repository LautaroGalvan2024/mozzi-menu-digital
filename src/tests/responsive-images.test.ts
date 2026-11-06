import { describe, expect, it, vi } from 'vitest'
import { assetVariantPaths, responsiveAssetUrls } from '../lib/images/responsive'

vi.mock('../lib/supabase/public-assets', () => ({ publicAssetUrl: (path: string) => `/public/${path}` }))

describe('responsive image paths', () => {
  it('derives every size from the primary responsive asset', () => {
    expect(assetVariantPaths('restaurants/r/products/p/uuid-1200.webp')).toEqual([
      'restaurants/r/products/p/uuid-320.webp',
      'restaurants/r/products/p/uuid-640.webp',
      'restaurants/r/products/p/uuid-1200.webp',
    ])
  })

  it('keeps legacy uploads as a single asset', () => {
    expect(assetVariantPaths('restaurants/r/products/p/legacy.webp')).toEqual([
      'restaurants/r/products/p/legacy.webp',
    ])
  })

  it('derives all portrait cleanup paths and their actual srcset widths', () => {
    const path = 'restaurants/r/cover/uuid-w1171-1171.webp'
    expect(assetVariantPaths(path)).toEqual([
      'restaurants/r/cover/uuid-w1171-320.webp',
      'restaurants/r/cover/uuid-w1171-640.webp',
      path,
    ])
    expect(responsiveAssetUrls(path)).toEqual({
      src: '/public/restaurants/r/cover/uuid-w1171-640.webp',
      srcSet: '/public/restaurants/r/cover/uuid-w1171-320.webp 320w, /public/restaurants/r/cover/uuid-w1171-640.webp 640w, /public/restaurants/r/cover/uuid-w1171-1171.webp 1171w',
    })
  })

  it('deduplicates narrow portrait paths without requesting nonexistent files', () => {
    const two = 'restaurants/r/cover/uuid-w400-400.webp'
    expect(assetVariantPaths(two)).toEqual(['restaurants/r/cover/uuid-w400-320.webp', two])
    expect(responsiveAssetUrls(two)).toEqual({
      src: `/public/${two}`,
      srcSet: '/public/restaurants/r/cover/uuid-w400-320.webp 320w, /public/restaurants/r/cover/uuid-w400-400.webp 400w',
    })
    const one = 'restaurants/r/cover/uuid-w60-60.webp'
    expect(assetVariantPaths(one)).toEqual([one])
    expect(responsiveAssetUrls(one)).toEqual({ src: `/public/${one}` })
  })

  it('keeps existing responsive image descriptors unchanged', () => {
    expect(responsiveAssetUrls('restaurants/r/cover/uuid-1200.webp')).toEqual({
      src: '/public/restaurants/r/cover/uuid-640.webp',
      srcSet: '/public/restaurants/r/cover/uuid-320.webp 320w, /public/restaurants/r/cover/uuid-640.webp 640w, /public/restaurants/r/cover/uuid-1200.webp 1200w',
    })
    expect(responsiveAssetUrls(null)).toEqual({ src: null })
  })

  it.each(['uuid-w0-0.webp', 'uuid-w1201-1201.webp', 'uuid-w1171-640.webp', 'uuid-w0-1200.webp'])('treats invalid bounded primary %s as a single file', filename => {
    const path = `restaurants/r/cover/${filename}`
    expect(assetVariantPaths(path)).toEqual([path])
    expect(responsiveAssetUrls(path)).toEqual({ src: `/public/${path}` })
  })
})
