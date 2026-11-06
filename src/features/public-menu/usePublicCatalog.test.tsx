import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommerceChannel } from '../../lib/commerce-channel'
import { queryKeys } from '../../lib/queryKeys'
import { usePublicCatalog } from './usePublicCatalog'

const mocks = vi.hoisted(() => ({ meta: vi.fn(), page: vi.fn(), revision: vi.fn(), detail: vi.fn() }))
vi.mock('./api', () => ({
  fetchPublicCatalogMeta: mocks.meta,
  fetchPublicCatalogPage: mocks.page,
  fetchPublicCatalogRevision: mocks.revision,
}))
vi.mock('../../lib/env', () => ({ env: { isSupabaseConfigured: true } }))

const restaurantId = '10000000-0000-4000-8000-000000000001'
const categoryId = '20000000-0000-4000-8000-000000000001'
const group = (id: string, name: string, available = true) => ({
  id,
  categoryId,
  family: null,
  variants: [{ id, categoryId, name, available }],
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

function AvailabilityProbe({ channel }: { channel: CommerceChannel }) {
  const catalog = usePublicCatalog('mozzi', channel)
  const detail = useQuery({ queryKey: queryKeys.publicCatalog.group('mozzi', channel, 'a'), queryFn: () => mocks.detail(channel), staleTime: Infinity })
  return <>
    <p data-testid="catalog-availability">{catalog.meta.data?.revision}:{catalog.groups[0]?.variants[0]?.available ? 'Disponible' : 'Agotado'}</p>
    <p data-testid="detail-availability">{detail.data?.revision}:{detail.data?.group.variants[0]?.available ? 'Disponible' : 'Agotado'}</p>
  </>
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

it.each(['menu', 'store'] as const)('refreshes %s availability and its cached detail when stock changes from unloaded to zero to positive', async channel => {
  // Availability is authoritative in the public API; balances remain private.
  let revision = 1
  let available = true
  const item = () => group('a', 'Producto con stock opcional', available)
  mocks.meta.mockImplementation(async () => meta(revision))
  mocks.page.mockImplementation(async () => ({ revision, items: [item()], nextCursor: null }))
  mocks.detail.mockImplementation(async () => ({ revision, group: item() }))
  mocks.revision.mockImplementation(async () => ({ revision, updatedAt: '2026-11-06T12:00:00Z' }))
  const queryClient = client()
  render(<QueryClientProvider client={queryClient}><AvailabilityProbe channel={channel} /></QueryClientProvider>)
  await waitFor(() => {
    expect(screen.getByTestId('catalog-availability')).toHaveTextContent('1:Disponible')
    expect(screen.getByTestId('detail-availability')).toHaveTextContent('1:Disponible')
  })

  for (const state of [{ revision: 2, available: false, label: 'Agotado' }, { revision: 3, available: true, label: 'Disponible' }]) {
    revision = state.revision
    available = state.available
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.publicCatalog.revision('mozzi', channel), exact: true }) })
    await waitFor(() => {
      expect(screen.getByTestId('catalog-availability')).toHaveTextContent(`${revision}:${state.label}`)
      expect(screen.getByTestId('detail-availability')).toHaveTextContent(`${revision}:${state.label}`)
    })
  }
  expect(mocks.page).toHaveBeenCalledWith(expect.objectContaining({ channel }))
  expect(mocks.detail).toHaveBeenCalledWith(channel)
  expect(mocks.detail.mock.calls.length).toBeGreaterThanOrEqual(3)
  queryClient.clear()
})
