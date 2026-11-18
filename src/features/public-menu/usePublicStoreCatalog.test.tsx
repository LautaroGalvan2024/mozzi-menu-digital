import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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

function SearchProbe({ search = '', slug = 'mozzi' }: { search?: string; slug?: string }) {
  const catalog = usePublicStoreCatalog(slug, 'all', '', search)
  if (catalog.isLoading) return <p>Cargando</p>
  return <>
    <input aria-label="Buscar productos" value={search} readOnly />
    <p>{catalog.groups.map(group => group.variants[0]?.name).join(' · ')}</p>
    {catalog.isShowingPreviousResults ? <p>Resultados anteriores</p> : null}
    {catalog.pages.hasNextPage ? <p>Más resultados</p> : null}
  </>
}

const pageData = (name: string) => ({
  revision: 1, serverNow: '2026-11-08T12:00:00.000Z', validUntil: null,
  items: [product(name)], nextCursor: null,
})

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

it('keeps the search input and settled products mounted while filters load, and ignores out-of-order responses', async () => {
  mocks.meta.mockResolvedValue(metadata)
  mocks.revision.mockResolvedValue({ revision: 1 })
  let resolveFirst!: (value: ReturnType<typeof pageData>) => void
  let resolveLatest!: (value: ReturnType<typeof pageData>) => void
  mocks.storePage.mockImplementation(({ search }) => search === 'ag'
    ? new Promise(resolve => { resolveFirst = resolve })
    : search === 'agua'
      ? new Promise(resolve => { resolveLatest = resolve })
      : Promise.resolve(pageData('Catálogo inicial')))
  const queryClient = createClient()
  const view = (search: string) => <QueryClientProvider client={queryClient}><SearchProbe search={search} /></QueryClientProvider>
  const { rerender } = render(view(''))
  await screen.findByText('Catálogo inicial')
  const input = screen.getByRole('textbox', { name: 'Buscar productos' })
  input.focus()

  rerender(view('ag'))
  await screen.findByText('Resultados anteriores')
  expect(screen.getByText('Catálogo inicial')).toBeVisible()
  expect(input).toHaveFocus()
  expect(screen.queryByText('Cargando')).not.toBeInTheDocument()
  rerender(view('agua'))
  await waitFor(() => expect(resolveLatest).toBeTypeOf('function'))
  await act(async () => resolveLatest(pageData('Agua mineral')))
  await screen.findByText('Agua mineral')
  await act(async () => resolveFirst(pageData('Resultado viejo')))
  expect(screen.queryByText('Resultado viejo')).not.toBeInTheDocument()
  expect(screen.queryByText('Resultados anteriores')).not.toBeInTheDocument()
  expect(input).toHaveFocus()
  queryClient.clear()
})

it('never retains products from another store while its catalog loads', async () => {
  mocks.meta.mockResolvedValue(metadata)
  mocks.revision.mockResolvedValue({ revision: 1 })
  mocks.storePage.mockImplementation(({ slug }) => slug === 'mozzi' ? Promise.resolve(pageData('Solo Mozzi')) : new Promise(() => {}))
  const queryClient = createClient()
  const view = (slug: string) => <QueryClientProvider client={queryClient}><SearchProbe slug={slug} /></QueryClientProvider>
  const { rerender } = render(view('mozzi'))
  await screen.findByText('Solo Mozzi')
  rerender(view('otra-tienda'))
  expect(screen.queryByText('Solo Mozzi')).not.toBeInTheDocument()
  expect(screen.getByText('Cargando')).toBeVisible()
  queryClient.clear()
})

it('removes an expired retained promotion during a slow search without unmounting the search input', async () => {
  const now = Date.now()
  mocks.meta.mockResolvedValue(metadata)
  mocks.revision.mockResolvedValue({ revision: 1 })
  mocks.storePage.mockImplementation(({ search }) => search ? new Promise(() => {}) : Promise.resolve({
    ...pageData('Oferta temporal'), serverNow: new Date(now).toISOString(), validUntil: new Date(now + 350).toISOString(), clientAnchorAt: now,
  }))
  const queryClient = createClient()
  const view = (search: string) => <QueryClientProvider client={queryClient}><SearchProbe search={search} /></QueryClientProvider>
  const { rerender } = render(view(''))
  await screen.findByText('Oferta temporal')
  const input = screen.getByRole('textbox', { name: 'Buscar productos' })
  input.focus()
  rerender(view('agua'))
  expect(screen.getByText('Oferta temporal')).toBeVisible()
  await waitFor(() => expect(screen.queryByText('Oferta temporal')).not.toBeInTheDocument())
  expect(input).toHaveFocus()
  expect(screen.queryByText('Cargando')).not.toBeInTheDocument()
  queryClient.clear()
})
