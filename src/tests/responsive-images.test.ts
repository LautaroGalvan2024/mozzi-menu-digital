import { describe, expect, it } from 'vitest'
import { assetVariantPaths } from '../lib/images/responsive'

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
})
