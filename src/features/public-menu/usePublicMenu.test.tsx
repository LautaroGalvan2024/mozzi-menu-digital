import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { queryKeys } from '../../lib/queryKeys'
import { usePublicMenu } from './usePublicMenu'

const mocks = vi.hoisted(() => ({ meta: vi.fn(), products: vi.fn(), revision: vi.fn() }))
vi.mock('./api', () => ({
  fetchPublicCatalogMeta: mocks.meta,
  fetchPublicProductsByIds: mocks.products,
  fetchPublicCatalogRevision: mocks.revision,
}))
vi.mock('../../lib/env', () => ({ env: { isSupabaseConfigured: true } }))
const productId = '10000000-0000-4000-8000-000000000001'
const categoryId = '20000000-0000-4000-8000-000000000001'
const product = { id: productId, categoryId }
function meta(name: string, revision: number) {
  return {
    revision,
    restaurant: { id: '30000000-0000-4000-8000-000000000001', name },
    categories: [{ id: categoryId }],
    businessHours: [], specialHours: [], paymentMethods: [], deliveryZones: [],
  }
}
function Menu() {
  const query = usePublicMenu('mozzi', 'menu', [productId])
  return <><p>{query.data?.restaurant.name}</p><p>{query.data?.categories.flatMap((category) => category.products).length}</p>{query.refreshError ? <p>Falló la actualización</p> : null}</>
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('reconciles only requested cart products and reloads them when the revision increases', async () => {
  let releaseRevision!: (value: { revision: number; updatedAt: string }) => void
  const revisionResult = new Promise<{ revision: number; updatedAt: string }>((resolve) => { releaseRevision = resolve })
  mocks.meta
    .mockResolvedValueOnce(meta('Menú inicial', 1))
    .mockResolvedValueOnce(meta('Precio revisado', 2))
  mocks.products
    .mockResolvedValueOnce({ revision: 1, products: [product] })
    .mockResolvedValueOnce({ revision: 2, products: [product] })
  mocks.revision.mockReturnValueOnce(revisionResult)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  render(<QueryClientProvider client={client}><Menu /></QueryClientProvider>)
  await screen.findByText('Menú inicial')
  releaseRevision({ revision: 2, updatedAt: '2026-10-29T12:00:20Z' })
  await screen.findByText('Precio revisado')
  expect(mocks.meta).toHaveBeenCalledTimes(2)
  expect(mocks.products).toHaveBeenCalledWith('mozzi', [productId], 'menu')
  client.clear()
})

it('keeps the last valid catalog visible when a revision refresh fails', async () => {
  mocks.meta.mockResolvedValue(meta('Menú vigente', 1))
  mocks.products.mockResolvedValue({ revision: 1, products: [product] })
  mocks.revision
    .mockResolvedValueOnce({ revision: 1, updatedAt: '2026-10-29T12:00:00Z' })
    .mockRejectedValueOnce(new Error('offline'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><Menu /></QueryClientProvider>)
  await screen.findByText('Menú vigente')
  await waitFor(() => expect(mocks.revision).toHaveBeenCalledTimes(1))

  await client.invalidateQueries({ queryKey: queryKeys.publicCatalog.revision('mozzi') })

  await screen.findByText('Falló la actualización')
  expect(screen.getByText('Menú vigente')).toBeInTheDocument()
  client.clear()
})
