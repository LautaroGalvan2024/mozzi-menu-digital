import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicProduct } from '../../types/domain'
import { StoreProductMedia } from './StoreProductMedia'

vi.mock('../../lib/supabase/public-assets', () => ({ publicAssetUrl: (path: string | null) => path ? `/assets/${path}` : null }))

const product: PublicProduct = {
  id: 'bottle', categoryId: 'drinks', code: 'BOTTLE', name: 'Agua 2L', description: '',
  basePriceCents: 90000, promotionalPriceCents: null, promotionStartsAt: null,
  promotionEndsAt: null, imagePath: 'bottle-1200.webp', available: true,
  featured: false, sortOrder: 0, quantityPrices: [], optionGroups: [],
}

afterEach(cleanup)

describe('store product photos', () => {
  it('retries the stored primary when a responsive derivative fails, then shows a useful fallback', () => {
    const { container } = render(<StoreProductMedia product={product} />)
    const photo = container.querySelector('img')!
    expect(photo).toHaveAttribute('srcset')
    fireEvent.error(photo)
    expect(photo).toHaveAttribute('src', '/assets/bottle-1200.webp')
    expect(photo).not.toHaveAttribute('srcset')
    fireEvent.error(photo)
    expect(screen.getByRole('img', { name: 'Foto no disponible' })).toBeVisible()
    expect(container.querySelector('img')).toBeNull()
  })

  it('recovers when switching the variant image after a failed photo', () => {
    const original = { ...product, imagePath: 'missing.webp' }
    const { container, rerender } = render(<StoreProductMedia product={original} />)
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByRole('img', { name: 'Foto no disponible' })).toBeVisible()
    rerender(<StoreProductMedia product={{ ...product, imagePath: 'available.webp' }} />)
    expect(container.querySelector('img')).toHaveAttribute('src', '/assets/available.webp')
    // Returning to a previous path starts a fresh attempt rather than retaining
    // the failed state from a different variant.
    rerender(<StoreProductMedia product={original} />)
    expect(container.querySelector('img')).toHaveAttribute('src', '/assets/missing.webp')
  })

  it('uses the family photo on cards and the selected variant photo on the detail', () => {
    const { container, rerender } = render(<StoreProductMedia product={product} familyImagePath="family.webp" />)
    expect(container.querySelector('img')).toHaveAttribute('src', '/assets/family.webp')
    rerender(<StoreProductMedia product={product} familyImagePath="family.webp" detail />)
    expect(screen.getByRole('button', { name: 'Ampliar foto de Agua 2L' }).querySelector('img')).toHaveAttribute('src', '/assets/bottle-640.webp')
  })

  it('preserves a deliberate empty state for products without a photo', () => {
    render(<StoreProductMedia product={{ ...product, imagePath: null }} detail />)
    expect(screen.getByRole('img', { name: 'Producto sin foto' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Ampliar/ })).not.toBeInTheDocument()
  })
})
