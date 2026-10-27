import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreSettingsPage } from './StoreSettingsPage'
import { RestaurantSettingsPage } from './RestaurantSettingsPage'
import type { RestaurantRow } from './useRestaurant'

const mocks = vi.hoisted(() => ({
  selectedId: '10000000-0000-4000-8000-000000000001',
  from: vi.fn(), invoke: vi.fn(), update: vi.fn(), updateScope: vi.fn(), updateSelect: vi.fn(), persist: vi.fn(), qr: vi.fn(),
}))
vi.mock('../../lib/supabase/client', () => ({ supabase: { from: mocks.from, functions: { invoke: mocks.invoke } } }))
vi.mock('../../lib/env', () => ({ env: { appBaseUrl: 'https://mozzi.example.test' } }))
vi.mock('qrcode', () => ({ default: { toDataURL: mocks.qr } }))
vi.mock('./RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: mocks.selectedId, role: 'restaurant_admin' } }) }))

const firstId = '10000000-0000-4000-8000-000000000001'
const secondId = '10000000-0000-4000-8000-000000000002'
let rows: Record<string, RestaurantRow>
const ready = { configured: true, readyForPayments: true, environment: 'production' }

function restaurant(id = firstId, overrides: Partial<RestaurantRow> = {}): RestaurantRow {
  return {
    id, name: 'Synthetic commerce', trade_name: 'Synthetic', slug: id === firstId ? 'first-shop' : 'second-shop',
    description: '', status: 'active', whatsapp_phone_e164: '+5491111111111', address: 'Synthetic', city: 'Synthetic',
    timezone: 'America/Argentina/Buenos_Aires', currency_code: 'ARS', locale: 'es-AR', logo_path: null, cover_path: null,
    primary_color: '#ff6600', secondary_color: '#000000', delivery_enabled: false, pickup_enabled: true,
    minimum_order_cents: 0, default_preparation_minutes: 20, public_menu_enabled: true, updated_at: '2026-10-27T12:00:00Z',
    inventory_mode: 'never_enabled', inventory_cutover_id: null, store_enabled: false, store_ordering_policy: 'always',
    store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false, ...overrides,
  }
}

function show(page: 'store' | 'settings' = 'store') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const tree = () => <QueryClientProvider client={client}><MemoryRouter>{page === 'store' ? <StoreSettingsPage /> : <RestaurantSettingsPage />}</MemoryRouter></QueryClientProvider>
  const view = render(tree())
  return { ...view, client, refreshScope: () => view.rerender(tree()) }
}
function storeCard() {
  return within(screen.getByRole('heading', { name: 'Tienda online', level: 3 }).closest('article')!)
}
async function publication() {
  return screen.findByRole('checkbox', { name: /Publicar mi tienda online/ })
}

describe('StoreSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectedId = firstId
    rows = { [firstId]: restaurant(), [secondId]: restaurant(secondId) }
    mocks.invoke.mockReset().mockResolvedValue({ data: { configured: false, readyForPayments: false, environment: 'production' }, error: null })
    mocks.qr.mockReset().mockResolvedValue('data:image/png;base64,c3ludGhldGlj')
    mocks.persist.mockReset().mockImplementation(async (id: string, patch: Partial<RestaurantRow>) => {
      rows[id] = { ...rows[id]!, ...patch }
      return { data: { id }, error: null }
    })
    mocks.update.mockImplementation((patch: Partial<RestaurantRow>) => ({
      eq: (column: string, id: string) => {
        mocks.updateScope(column, id)
        return { select: (columns: string) => {
          mocks.updateSelect(columns)
          return { maybeSingle: () => mocks.persist(id, patch) }
        } }
      },
    }))
    mocks.from.mockImplementation((table: string) => {
      if (table !== 'restaurants') throw new Error(`Unexpected table ${table}`)
      return { update: mocks.update, select: () => ({ eq: (_column: string, id: string) => ({ single: async () => ({ data: rows[id], error: null }) }) }) }
    })
  })
  afterEach(cleanup)

  it('publishes WhatsApp-only without a connected provider or active inventory and writes only the four tenant fields', async () => {
    const user = userEvent.setup()
    show()
    await user.click(await publication())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cuándo recibir pedidos' }), 'business_hours')
    expect(screen.getByRole('checkbox', { name: 'Pagos online con Mercado Pago' })).toBeDisabled()
    expect(storeCard().getByText('Sin publicar')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Tu tienda está publicada')
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      store_enabled: true, store_ordering_policy: 'business_hours',
      store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false,
    })
    expect(mocks.updateScope).toHaveBeenCalledExactlyOnceWith('id', firstId)
    expect(mocks.updateSelect).toHaveBeenCalledExactlyOnceWith('id')
    await waitFor(() => expect(storeCard().getByText('Publicado')).toBeVisible())
    expect(storeCard().getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', 'https://mozzi.example.test/t/first-shop')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Configurar entrega y datos del comercio' })).toHaveAttribute('href', '/admin/configuracion')
  })

  it('still publishes WhatsApp-only when the provider status request fails', async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: new Error('Provider unavailable') })
    const user = userEvent.setup()
    show()
    expect(await screen.findByRole('button', { name: 'Reintentar consulta de Mercado Pago' })).toBeVisible()
    await user.click(await publication())
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Tu tienda está publicada')
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update.mock.calls[0]![0].store_checkout_online_enabled).toBe(false)
  })

  it('blocks publication without a purchase method', async () => {
    const user = userEvent.setup()
    show()
    await user.click(await publication())
    await user.click(screen.getByRole('checkbox', { name: 'Pedidos por WhatsApp' }))
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Elegí pedidos por WhatsApp, pagos online o ambas opciones')
    expect(mocks.update).not.toHaveBeenCalled()
    expect(storeCard().getByText('Sin publicar')).toBeVisible()
  })

  it('blocks publication until pickup or delivery is enabled', async () => {
    rows[firstId] = restaurant(firstId, { pickup_enabled: false, delivery_enabled: false })
    const user = userEvent.setup()
    show()
    await user.click(await publication())
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Primero habilitá retiro o envío en Configuración')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('blocks publication of an inactive commerce', async () => {
    rows[firstId] = restaurant(firstId, { status: 'suspended' })
    const user = userEvent.setup()
    show()
    await user.click(await publication())
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('El comercio debe estar activo')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each([
    ['currency is not ARS', { currency_code: 'USD', inventory_mode: 'enforced' }, ready],
    ['stock is not enabled', { inventory_mode: 'never_enabled' }, ready],
    ['stock is paused', { inventory_mode: 'paused' }, ready],
    ['a physical count is open', { inventory_mode: 'enforced', inventory_cutover_id: '90000000-0000-4000-8000-000000000001' }, ready],
    ['provider application is not configured', { inventory_mode: 'enforced' }, { ...ready, configured: false }],
    ['merchant connection is not ready', { inventory_mode: 'enforced' }, { ...ready, readyForPayments: false }],
  ] satisfies Array<[string, Partial<RestaurantRow>, typeof ready]>)('does not enable online payment when %s', async (_label, overrides, provider) => {
    rows[firstId] = restaurant(firstId, overrides)
    mocks.invoke.mockResolvedValue({ data: provider, error: null })
    const view = show()
    await publication()
    await waitFor(() => expect(view.client.getQueryState(['store-payment-readiness', firstId])?.status).toBe('success'))
    expect(mocks.invoke).toHaveBeenCalledWith('mercadopago-connect', { body: { restaurantId: firstId, action: 'status' } })
    expect(screen.getByRole('checkbox', { name: 'Pagos online con Mercado Pago' })).toBeDisabled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('enables online publication only after the account, currency and inventory are ready', async () => {
    rows[firstId] = restaurant(firstId, { inventory_mode: 'enforced', pickup_enabled: false, delivery_enabled: true })
    mocks.invoke.mockResolvedValue({ data: ready, error: null })
    const user = userEvent.setup()
    show()
    await publication()
    const online = screen.getByRole('checkbox', { name: 'Pagos online con Mercado Pago' })
    await waitFor(() => expect(online).toBeEnabled())
    await user.click(online)
    await user.click(screen.getByRole('checkbox', { name: 'Pedidos por WhatsApp' }))
    await user.click(await publication())
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Tu tienda está publicada')
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ store_enabled: true, store_ordering_policy: 'always', store_checkout_whatsapp_enabled: false, store_checkout_online_enabled: true })
    expect(screen.getByText('Mercado Pago: cuenta autorizada para cobros reales.')).toBeVisible()
  })

  it('allows removing a previously enabled online method when its connection is no longer ready', async () => {
    rows[firstId] = restaurant(firstId, { store_checkout_online_enabled: true })
    const user = userEvent.setup()
    show()
    await publication()
    const online = screen.getByRole('checkbox', { name: 'Pagos online con Mercado Pago' })
    expect(online).toBeChecked()
    expect(online).toBeEnabled()
    await user.click(await publication())
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Para cobrar online, conectá Mercado Pago')
    expect(mocks.update).not.toHaveBeenCalled()
    await user.click(online)
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Tu tienda está publicada')
    expect(mocks.update.mock.calls[0]![0].store_checkout_online_enabled).toBe(false)
  })

  it.each([
    ['database rejects update', { data: null, error: { message: 'Rejected' } }],
    ['no scoped row was written', { data: null, error: null }],
    ['server returned a different tenant', { data: { id: secondId }, error: null }],
  ])('keeps publication badges and QR metadata unpublished when %s', async (_label, response) => {
    mocks.persist.mockResolvedValue(response)
    const user = userEvent.setup()
    show()
    await user.click(await publication())
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos guardar la tienda')
    expect(screen.queryByText('Publicada', { exact: true })).not.toBeInTheDocument()
    expect(storeCard().getByText('Sin publicar')).toBeVisible()
    expect(storeCard().queryByText('Publicado', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await user.click(storeCard().getByRole('button', { name: 'Ver QR' }))
    expect(await storeCard().findByRole('img', { name: 'Código QR de Tienda online' })).toBeVisible()
    expect(mocks.qr).toHaveBeenCalledWith('https://mozzi.example.test/t/first-shop', { width: 256, margin: 2 })
  })

  it('resets unsaved form data, payment scope and error when changing commerce', async () => {
    rows[secondId] = restaurant(secondId, { store_enabled: true, store_ordering_policy: 'always', store_checkout_whatsapp_enabled: true })
    mocks.persist.mockResolvedValueOnce({ data: null, error: { message: 'Save failed' } })
    const user = userEvent.setup()
    const view = show()
    await user.click(await publication())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cuándo recibir pedidos' }), 'business_hours')
    await user.click(screen.getByRole('button', { name: 'Guardar y publicar tienda' }))
    expect(await screen.findByRole('alert')).toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: 'Pedidos por WhatsApp' }))
    mocks.selectedId = secondId
    view.refreshScope()
    expect(await publication()).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Pedidos por WhatsApp' })).toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Cuándo recibir pedidos' })).toHaveValue('always')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(storeCard().getByText('Publicado')).toBeVisible()
    expect(storeCard().getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', 'https://mozzi.example.test/t/second-shop')
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('mercadopago-connect', { body: { restaurantId: secondId, action: 'status' } }))
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await screen.findByRole('status')
    expect(mocks.updateScope).toHaveBeenLastCalledWith('id', secondId)
    expect(mocks.update).toHaveBeenLastCalledWith({ store_enabled: true, store_ordering_policy: 'always', store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false })
  })

  it('generates a channel QR only when requested, while sharing links remain available', async () => {
    const user = userEvent.setup(); show()
    await publication()
    expect(mocks.qr).not.toHaveBeenCalled()
    expect(storeCard().getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', 'https://mozzi.example.test/t/first-shop')
    expect(storeCard().queryByRole('img')).not.toBeInTheDocument()
    await user.click(storeCard().getByRole('button', { name: 'Ver QR' }))
    expect(await storeCard().findByRole('img', { name: 'Código QR de Tienda online' })).toBeVisible()
    expect(mocks.qr).toHaveBeenCalledExactlyOnceWith('https://mozzi.example.test/t/first-shop', { width: 256, margin: 2 })
    expect(storeCard().getByRole('link', { name: 'Descargar QR' })).toHaveAttribute('download', 'first-shop-store-qr.png')
    await user.click(storeCard().getByRole('button', { name: 'Ocultar QR' }))
    expect(storeCard().queryByRole('img')).not.toBeInTheDocument()
  })

  it('keeps general settings edits during a background refresh and never writes store publication fields', async () => {
    const user = userEvent.setup(); const view = show('settings')
    const name = await screen.findByRole('textbox', { name: 'Nombre comercial' })
    await user.clear(name); await user.type(name, 'Nuevo nombre')
    rows[firstId] = { ...rows[firstId]!, store_enabled: true, store_checkout_online_enabled: true }
    await view.client.invalidateQueries({ queryKey: ['restaurant', firstId] })
    expect(name).toHaveValue('Nuevo nombre')
    expect(screen.queryByRole('checkbox', { name: 'Tienda publicada' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Configurar tienda online' })).toHaveAttribute('href', '/admin/tienda')
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Configuración guardada.')
    const patch = mocks.update.mock.calls[0]![0]
    expect(patch.trade_name).toBe('Nuevo nombre')
    for (const key of ['store_enabled', 'store_ordering_policy', 'store_checkout_whatsapp_enabled', 'store_checkout_online_enabled']) expect(patch).not.toHaveProperty(key)
    expect(rows[firstId]!.store_enabled).toBe(true)
    expect(rows[firstId]!.store_checkout_online_enabled).toBe(true)
    expect(mocks.updateScope).toHaveBeenCalledExactlyOnceWith('id', firstId)
  })

  it('resets general settings when switching commerce without carrying unsaved identity', async () => {
    const user = userEvent.setup(); const view = show('settings')
    const name = await screen.findByRole('textbox', { name: 'Nombre comercial' })
    await user.clear(name); await user.type(name, 'Primer comercio editado')
    rows[secondId] = restaurant(secondId, { trade_name: 'Segundo comercio' })
    mocks.selectedId = secondId; view.refreshScope()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nombre comercial' })).toHaveValue('Segundo comercio'))
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await screen.findByRole('status')
    expect(mocks.updateScope).toHaveBeenCalledExactlyOnceWith('id', secondId)
    expect(mocks.update.mock.calls[0]![0].trade_name).toBe('Segundo comercio')
  })
})
