import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePublicStoreCatalog } from './usePublicCatalog'

const mocks = vi.hoisted(() => ({ meta: vi.fn(), storePage: vi.fn(), revision: vi.fn() }))
vi.mock('./api', () => ({
  fetchPublicCatalogMeta: mocks.meta,
  fetchPublicCatalogRevision: mocks.revision,
  fetchPublicStoreCatalogPage: mocks.storePage,
  fetchPublicCatalogPage: vi.fn(),
  PublicCatalogCategoryInvalidError: class PublicCatalogCategoryInvalidError extends Error {},
  PublicCatalogCursorStaleError: class PublicCatalogCursorStaleError extends Error {},
}))
vi.mock('../../lib/env', () => ({ env: { isSupabaseConfigured: true } }))

const restaurantId = '10000000-0000-4000-8000-000000000001'
const categoryId = '20000000-0000-4000-8000-000000000001'
const product = (name: string) => ({
  id: `30000000-0000-4000-8000-${name === 'Oferta nueva' ? '000000000002' : '000000000001'}`,
  categoryId,
  family: null,
  variants: [{ id: '40000000-0000-4000-8000-000000000001', categoryId, name, available: true }],
})
const metadata = {
  revision: 1,
  restaurant: { id: restaurantId, name: 'Mozzi' },
  categories: [], businessHours: [], specialHours: [], paymentMethods: [], deliveryZones: [],
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}

function Probe() {
  const catalog = usePublicStoreCatalog('mozzi', 'offers', categoryId, 'yerba', 8)
  if (catalog.isLoading) return <p>Cargando</p>
  return <p>{catalog.groups.map(group => group.variants[0]?.name).join(' · ')}</p>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('requests a server-filtered store section with the selected scope', async () => {
  mocks.meta.mockResolvedValue(metadata)
  mocks.revision.mockResolvedValue({ revision: 1, updatedAt: '2026-11-08T12:00:00.000Z' })
  mocks.storePage.mockResolvedValue({
    revision: 1,
    serverNow: '2026-11-08T12:00:00.000Z',
    validUntil: null,
    items: [product('Oferta vigente')],
    nextCursor: null,
  })
  const queryClient = createClient()
  render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)

  await screen.findByText('Oferta vigente')
  expect(mocks.storePage).toHaveBeenCalledWith({
    slug: 'mozzi', section: 'offers', categoryId, search: 'yerba', limit: 8,
  })
  queryClient.clear()
})

it('drops an expired promotion snapshot and reloads it using server time', async () => {
  const now = new Date()
  mocks.meta.mockResolvedValue(metadata)
  mocks.revision.mockResolvedValue({ revision: 1, updatedAt: now.toISOString() })
  mocks.storePage
    .mockResolvedValueOnce({
      revision: 1,
      serverNow: now.toISOString(),
      validUntil: new Date(now.getTime() + 80).toISOString(),
      items: [product('Oferta anterior')],
      nextCursor: null,
    })
    .mockResolvedValue({
      revision: 1,
      serverNow: new Date(now.getTime() + 100).toISOString(),
      validUntil: null,
      items: [product('Oferta nueva')],
      nextCursor: null,
    })
  const queryClient = createClient()
  render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)

  await screen.findByText('Oferta anterior')
  await waitFor(() => expect(screen.getByText('Oferta nueva')).toBeInTheDocument(), { timeout: 2_000 })
  expect(mocks.storePage.mock.calls.length).toBeGreaterThanOrEqual(2)
  queryClient.clear()
})
