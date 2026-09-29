import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BrandPage } from './BrandPage'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  processImage: vi.fn(),
  uploadRestaurantImage: vi.fn(),
}))

vi.mock('../../lib/supabase/client', () => ({
  publicAssetUrl: () => null,
  supabase: {
    from: mocks.from,
    storage: { from: vi.fn() },
  },
}))

vi.mock('../../lib/images/processImage', () => ({
  processImage: mocks.processImage,
}))

vi.mock('../../lib/images/upload', () => ({
  uploadRestaurantImage: mocks.uploadRestaurantImage,
}))

vi.mock('./RestaurantScope', () => ({
  useRestaurantScope: () => ({
    selected: {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Restaurante de prueba',
      slug: 'restaurante-prueba',
      status: 'active',
      role: 'restaurant_admin',
    },
  }),
}))

vi.mock('./useRestaurant', () => ({
  useRestaurant: () => ({
    isLoading: false,
    error: null,
    data: { logo_path: null, cover_path: null },
  }),
}))

describe('restaurant brand images', () => {
  it('uploads and associates a new logo with the selected restaurant', async () => {
    const processed = {
      blob: new Blob(['processed'], { type: 'image/webp' }),
      width: 800,
      height: 800,
      filename: 'logo.webp',
      mimeType: 'image/webp' as const,
    }
    mocks.processImage.mockResolvedValue(processed)
    mocks.uploadRestaurantImage.mockResolvedValue(
      'restaurants/10000000-0000-4000-8000-000000000001/logo/logo.webp',
    )
    const single = vi.fn().mockResolvedValue({ data: { id: '10000000-0000-4000-8000-000000000001' }, error: null })
    const select = vi.fn(() => ({ single }))
    const eq = vi.fn(() => ({ select }))
    const update = vi.fn(() => ({ eq }))
    mocks.from.mockReturnValue({ update })

    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <BrandPage />
      </QueryClientProvider>,
    )
    const input = container.querySelector<HTMLInputElement>('#logo-upload')
    expect(input).not.toBeNull()

    const file = new File(['source'], 'logo.png', { type: 'image/png' })
    fireEvent.change(input!, { target: { files: [file] } })

    await waitFor(() => expect(mocks.uploadRestaurantImage).toHaveBeenCalledWith({
      restaurantId: '10000000-0000-4000-8000-000000000001',
      kind: 'logo',
      image: processed,
    }))
    expect(update).toHaveBeenCalledWith({
      logo_path: 'restaurants/10000000-0000-4000-8000-000000000001/logo/logo.webp',
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['restaurant', '10000000-0000-4000-8000-000000000001'],
    })
  })
})
