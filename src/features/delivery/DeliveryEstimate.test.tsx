import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryEstimate } from './DeliveryEstimate'

const mocks = vi.hoisted(() => ({ quote: vi.fn() }))
vi.mock('./delivery-api', () => ({ getDeliveryEstimate: mocks.quote }))
const zoneId = 'e1900000-0000-4000-8000-000000000002'
const clients: QueryClient[] = []
function view(deliveryZoneId: string | undefined = zoneId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><DeliveryEstimate restaurantSlug="test" deliveryZoneId={deliveryZoneId} channel="store" /></QueryClientProvider>)
}

describe('delivery estimate in checkout', () => {
  afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0 })
  beforeEach(() => mocks.quote.mockReset())
  it('does not request a date until a zone is selected', () => {
    view('')
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(screen.queryByText(/Entrega estimada/)).not.toBeInTheDocument()
  })
  it('keeps disabled calendars invisible', async () => {
    mocks.quote.mockResolvedValue({ enabled: false, estimatedDate: null })
    const { container } = view()
    await waitFor(() => expect(mocks.quote).toHaveBeenCalledWith('test', zoneId, 'store', expect.any(AbortSignal)))
    expect(container).toBeEmptyDOMElement()
  })
  it('shows the server calendar date as an estimate with no selection fields', async () => {
    mocks.quote.mockResolvedValue({ enabled: true, estimatedDate: '2026-11-20' })
    view()
    expect(await screen.findByText('Entrega estimada: viernes, 20 de noviembre')).toBeVisible()
    expect(screen.getByText('El comercio confirma la fecha de entrega.')).toBeVisible()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
