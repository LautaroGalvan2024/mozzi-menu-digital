import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminDashboardPage } from './AdminDashboardPage'

const mocks = vi.hoisted(() => ({
  selected: { id: '10000000-0000-4000-8000-000000000001', name: 'Casa Móvil', slug: 'casa-movil', role: 'restaurant_admin' },
  rpc: vi.fn(), qr: vi.fn(),
}))
vi.mock('./RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: mocks.selected }) }))
vi.mock('./useRestaurant', () => ({ useRestaurant: () => ({ data: { timezone: 'America/Argentina/Buenos_Aires', currency_code: 'ARS', locale: 'es-AR', public_menu_enabled: true, store_enabled: true }, isLoading: false, error: null }) }))
vi.mock('../../lib/env', () => ({ env: { appBaseUrl: 'https://mozzi.example.test' } }))
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.qr } }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { rpc: mocks.rpc, channel: () => ({ on() { return this }, subscribe() { return this } }), removeChannel: vi.fn() } }))

function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AdminDashboardPage /></MemoryRouter></QueryClientProvider>)
}

describe('quiet administrative overview', () => {
  beforeEach(() => {
    mocks.selected.role = 'restaurant_admin'
    mocks.qr.mockReset()
    mocks.rpc.mockReset().mockResolvedValue({ error: null, data: {
      generated: 8, whatsappOpened: 4, accepted: 5, completed: 3, cancelled: 1, expired: 0,
      corrected: 1, returned: 1, acceptedAmountCents: '125000', completedAmountCents: '100000',
      byFulfillment: { delivery: 5, pickup: 3 }, byPaymentMethod: [{ name: 'Efectivo', count: 3, amountCents: '100000' }],
      validDeliveredCommercialCases: 3, physicalDispatches: 4, receivedReturnUnits: '2', sellableRestockedReturnUnits: '1',
    } })
  })
  afterEach(cleanup)

  it('shows four primary metrics and keeps the detailed accounting available on demand', async () => {
    const user = userEvent.setup(); show()
    await screen.findByRole('heading', { name: 'Resumen', level: 1 })
    const overview = within(screen.getByRole('region', { name: 'Resumen del día' }))
    expect(overview.getAllByRole('heading', { level: 2 })).toHaveLength(4)
    expect(overview.getByRole('heading', { name: 'Importe aceptado o entregado' })).toBeVisible()
    expect(overview.getByText(/no confirman cobros ni reintegros/)).toBeVisible()
    expect(screen.getByText('Casos comerciales entregados vigentes')).not.toBeVisible()
    expect(screen.getByRole('link', { name: /Ver pedidos/ })).toHaveAttribute('href', '/admin/pedidos')
    expect(mocks.qr).not.toHaveBeenCalled()
    await user.click(screen.getByText('Ver detalle del día'))
    expect(screen.getByText('Casos comerciales entregados vigentes')).toBeVisible()
    expect(screen.getByText('Aceptados alguna vez')).toBeVisible()
    expect(screen.getByText('Unidades devueltas repuestas como vendibles')).toBeVisible()
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('get_order_metrics', expect.objectContaining({ p_restaurant_id: mocks.selected.id }))
  })

  it('does not offer catalog or store configuration to an order manager', async () => {
    mocks.selected.role = 'order_manager'; show()
    await screen.findByRole('heading', { name: 'Resumen', level: 1 })
    expect(screen.getByRole('link', { name: /Stock disponible/ })).toHaveAttribute('href', '/admin/stock')
    expect(screen.queryByRole('link', { name: /Tu catálogo|Tu tienda online|Configurar mi tienda/ })).not.toBeInTheDocument()
  })
})
