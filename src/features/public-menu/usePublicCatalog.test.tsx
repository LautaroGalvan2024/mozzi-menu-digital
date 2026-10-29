import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { queryKeys } from '../../lib/queryKeys'
import { usePublicCatalog } from './usePublicCatalog'

const mocks = vi.hoisted(() => ({ meta: vi.fn(), page: vi.fn(), revision: vi.fn() }))
vi.mock('./api', () => ({
  fetchPublicCatalogMeta: mocks.meta,
  fetchPublicCatalogPage: mocks.page,
  fetchPublicCatalogRevision: mocks.revision,
}))
vi.mock('../../lib/env', () => ({ env: { isSupabaseConfigured: true } }))

const restaurantId = '10000000-0000-4000-8000-000000000001'
const categoryId = '20000000-0000-4000-8000-000000000001'
const group = (id: string, name: string) => ({
  id,
  categoryId,
  family: null,
  variants: [{ id, categoryId, name }],
})
const meta = (revision: number) => ({
  revision,
  restaurant: { id: restaurantId, name: 'Mozzi' },
  categories: [{ id: categoryId }],
  businessHours: [], specialHours: [], paymentMethods: [], deliveryZones: [],
})

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}

function Probe({ search = '' }: { search?: string }) {
  const catalog = usePublicCatalog('mozzi', 'menu', '', search)
  if (catalog.isLoading) return <p>Cargando catálogo</p>
  return <>
    <p data-testid="revisions">{catalog.meta.data?.revision}:{catalog.pages.data?.pages.map((page) => page.revision).join(',')}</p>
    <p>{catalog.groups.map((item) => item.variants[0]?.name).join(' · ')}</p>
    {catalog.pages.hasNextPage ? <button disabled={catalog.pages.isFetching} onClick={() => void catalog.pages.fetchNextPage()}>Más</button> : null}
    {catalog.refreshError ? <p>Error de actualización</p> : null}
  </>
}

function FilterProbe() {
  const [search, setSearch] = useState('')
  return <><button onClick={() => setSearch('nuevo')}>Filtrar</button><Probe search={search} /></>
}

function ErrorProbe() {
  const catalog = usePublicCatalog('mozzi', 'menu')
  if (catalog.isLoading) return <p>Cargando catálogo</p>
  if (!catalog.meta.data || !catalog.pages.data) return <p>No se pudo cargar el catálogo</p>
  return <p>Catálogo listo</p>
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('leaves the initial loading state when the catalog request fails', async () => {
  mocks.meta.mockRejectedValue(new Error('not found'))
  mocks.page.mockRejectedValue(new Error('not found'))
  const queryClient = client()
  render(<QueryClientProvider client={queryClient}><ErrorProbe /></QueryClientProvider>)

  await screen.findByText('No se pudo cargar el catálogo', {}, { timeout: 5_000 })
  expect(screen.queryByText('Cargando catálogo')).not.toBeInTheDocument()
  queryClient.clear()
})

it('never exposes a page older than metadata and refreshes it to the same revision', async () => {
  mocks.meta.mockResolvedValue(meta(2))
  mocks.revision.mockResolvedValue({ revision: 2, updatedAt: '2026-10-29T12:00:00Z' })
  mocks.page
    .mockResolvedValueOnce({ revision: 1, items: [group('old', 'Viejo')], nextCursor: null })
    .mockResolvedValueOnce({ revision: 2, items: [group('fresh', 'Fresco')], nextCursor: null })
  const queryClient = client()
  render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)

  await screen.findByText('Fresco')
  expect(screen.queryByText('Viejo')).not.toBeInTheDocument()
  expect(screen.getByTestId('revisions')).toHaveTextContent('2:2')
  expect(mocks.page).toHaveBeenCalledTimes(2)
  queryClient.clear()
})

it('discards mixed later pages and reloads the complete page chain consistently', async () => {
  mocks.meta.mockResolvedValueOnce(meta(1)).mockResolvedValue(meta(2))
  mocks.revision.mockResolvedValue({ revision: 1, updatedAt: '2026-10-29T12:00:00Z' })
  let rootLoads = 0
  mocks.page.mockImplementation(async ({ cursor }: { cursor?: string }) => {
    if (!cursor) {
      rootLoads += 1
      return rootLoads === 1
        ? { revision: 1, items: [group('a', 'Inicial')], nextCursor: 'next' }
        : { revision: 2, items: [group('a', 'Actualizado')], nextCursor: 'next' }
    }
    return rootLoads === 1
      ? { revision: 2, items: [group('b', 'Página incompatible')], nextCursor: null }
      : { revision: 2, items: [group('b', 'Página actualizada')], nextCursor: null }
  })
  const queryClient = client()
  render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)
  await screen.findByText('Inicial')
  fireEvent.click(screen.getByRole('button', { name: 'Más' }))

  await screen.findByText('Actualizado · Página actualizada')
  expect(screen.queryByText(/Página incompatible/)).not.toBeInTheDocument()
  expect(screen.getByTestId('revisions')).toHaveTextContent('2:2,2')
  queryClient.clear()
})

it('does not expose the previous cursor while a new filter is loading', async () => {
  let releaseFiltered!: (value: unknown) => void
  const filtered = new Promise((resolve) => { releaseFiltered = resolve })
  mocks.meta.mockResolvedValue(meta(1))
  mocks.revision.mockResolvedValue({ revision: 1, updatedAt: '2026-10-29T12:00:00Z' })
  mocks.page.mockImplementation(({ search }: { search?: string }) => search
    ? filtered
    : Promise.resolve({ revision: 1, items: [group('a', 'Inicial')], nextCursor: 'old-cursor' }))
  const queryClient = client()
  render(<QueryClientProvider client={queryClient}><FilterProbe /></QueryClientProvider>)
  await screen.findByRole('button', { name: 'Más' })

  fireEvent.click(screen.getByRole('button', { name: 'Filtrar' }))

  expect(screen.queryByRole('button', { name: 'Más' })).not.toBeInTheDocument()
  expect(mocks.page.mock.calls.at(-1)?.[0]).toMatchObject({ search: 'nuevo' })
  expect(mocks.page.mock.calls.at(-1)?.[0]).not.toHaveProperty('cursor')
  releaseFiltered({ revision: 1, items: [], nextCursor: null })
  queryClient.clear()
})

it('preserves the last consistent snapshot when a refresh fails', async () => {
  mocks.meta.mockResolvedValue(meta(1))
  mocks.revision.mockResolvedValue({ revision: 1, updatedAt: '2026-10-29T12:00:00Z' })
  mocks.page
    .mockResolvedValueOnce({ revision: 1, items: [group('a', 'Vigente')], nextCursor: null })
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
  const queryClient = client()
  render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>)
  await screen.findByText('Vigente')

  await queryClient.invalidateQueries({ queryKey: queryKeys.publicCatalog.pages('mozzi', 'menu') })

  await screen.findByText('Error de actualización')
  expect(screen.getByText('Vigente')).toBeInTheDocument()
  queryClient.clear()
})
