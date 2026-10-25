import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePublicMenu } from './usePublicMenu'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./api', () => ({ fetchPublicMenu: mocks.fetch }))
vi.mock('../../lib/env', () => ({ env: { isSupabaseConfigured: true } }))
function Menu() { const query = usePublicMenu('mozzi'); return <p>{query.data?.restaurant.name}</p> }
afterEach(() => { cleanup(); focusManager.setFocused(undefined); vi.clearAllMocks() })

it('revalidates a fresh cached menu on remount and on returning focus', async () => {
  mocks.fetch.mockResolvedValueOnce({ restaurant: { name: 'Menú inicial' } }).mockResolvedValueOnce({ restaurant: { name: 'Precio revisado' } }).mockResolvedValueOnce({ restaurant: { name: 'Disponibilidad revisada' } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const app = () => <QueryClientProvider client={client}><Menu /></QueryClientProvider>
  const first = render(app()); await screen.findByText('Menú inicial'); first.unmount()
  render(app()); await screen.findByText('Precio revisado')
  act(() => focusManager.setFocused(false))
  act(() => focusManager.setFocused(true))
  await screen.findByText('Disponibilidad revisada')
  expect(mocks.fetch).toHaveBeenCalledTimes(3)
  client.clear()
})
