import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CampaignsPage } from './CampaignsPage'

const tenant = '31310000-0000-4000-8000-000000000010'
const productId = '31310000-0000-4000-8000-000000000030'
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), from: vi.fn() }))
vi.mock('./admin-api', () => ({ getAdminCampaigns: mocks.list, saveCampaign: mocks.save }))
vi.mock('./api', () => ({ getPublicCampaign: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { from: mocks.from } }))
vi.mock('../restaurants/RestaurantScope', () => ({ useRestaurantScope: () => ({ selected: { id: '31310000-0000-4000-8000-000000000010' } }) }))
vi.mock('../restaurants/useRestaurant', () => ({ useRestaurant: () => ({ data: { id: '31310000-0000-4000-8000-000000000010', slug: 'shop', trade_name: 'Mi comercio', public_menu_enabled: true, store_enabled: true, currency_code: 'ARS', locale: 'es-AR', timezone: 'America/Argentina/Buenos_Aires' } }) }))
const product = { id: productId, name: 'Cable USB', code: '001', image_path: null, base_price_cents: 150000, promotional_price_cents: null, promotion_starts_at: null, promotion_ends_at: null, active: true, available: true, family_id: null, variant_attributes: {} }
function page() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><MemoryRouter><CampaignsPage /></MemoryRouter></QueryClientProvider>) }
beforeEach(() => {
  localStorage.clear(); mocks.list.mockReset().mockResolvedValue([]); mocks.save.mockReset()
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = {}; for (const method of ['select', 'eq', 'in', 'is', 'order', 'range', 'or']) query[method] = () => query
    query.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ data: table === 'categories' ? [] : [product], count: 1, error: null }).then(resolve)
    return query
  })
  mocks.save.mockImplementation(async ({ draft }: { draft: Record<string, unknown> }) => ({ ...draft, slug: draft.id, version: 1, updatedAt: '2026-11-19T12:00:00Z' }))
})
afterEach(cleanup)

describe('campaign editor workflow', () => {
  it('uses selected catalogue products without requiring photos or retyping prices', async () => {
    const user = userEvent.setup(); page()
    await user.click(await screen.findByRole('button', { name: 'Nueva revista' }))
    await user.type(screen.getByRole('textbox', { name: 'Título' }), 'Ofertas de noviembre')
    await user.click(await screen.findByRole('checkbox', { name: /Cable USB/ }))
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0]![0].draft).toMatchObject({ title: 'Ofertas de noviembre', productIds: [productId], channels: ['menu', 'store'], imagePath: null, status: 'draft' })
    expect(await screen.findByText(/Borrador guardado/)).toBeVisible()
  })
  it('preserves the exact request after an uncertain failure and does not duplicate the publication', async () => {
    const user = userEvent.setup(); mocks.save.mockRejectedValueOnce(new Error('Se interrumpió la conexión.'))
    page(); await user.click(await screen.findByRole('button', { name: 'Nuevo anuncio' }))
    await user.type(screen.getByRole('textbox', { name: 'Título' }), 'Nuevos horarios')
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }))
    await screen.findByText('Se interrumpió la conexión.')
    expect(screen.getByRole('textbox', { name: 'Título' })).toBeDisabled()
    const stored = JSON.parse(localStorage.getItem(`mozzi:campaign-draft:${tenant}`)!)
    expect(stored.pending.requestId).toBe(mocks.save.mock.calls[0]![0].requestId)
    await user.click(screen.getByRole('button', { name: 'Reintentar guardado' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]![0]).toEqual(mocks.save.mock.calls[0]![0])
    expect(await screen.findByText(/Borrador guardado/)).toBeVisible()
  })
  it('restores local work and keeps catalogue selection after returning to the list', async () => {
    const user = userEvent.setup(); page()
    await user.click(await screen.findByRole('button', { name: 'Nueva revista' }))
    await user.type(screen.getByRole('textbox', { name: 'Título' }), 'Selección guardada')
    await user.click(await screen.findByRole('checkbox', { name: /Cable USB/ }))
    await user.click(screen.getByRole('button', { name: 'Volver al listado' }))
    await user.click(screen.getByRole('button', { name: 'Continuar última edición' }))
    expect(screen.getByRole('textbox', { name: 'Título' })).toHaveValue('Selección guardada')
    expect(screen.getByRole('checkbox', { name: /Cable USB/ })).toBeChecked()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('reloads the saved list after a definitive conflict while retaining local edits', async () => {
    const user = userEvent.setup()
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('Otra persona cambió esta publicación.'), { definitive: true }))
    page(); await user.click(await screen.findByRole('button', { name: 'Nuevo anuncio' }))
    await user.type(screen.getByRole('textbox', { name: 'Título' }), 'Mi edición local')
    await user.click(screen.getByRole('button', { name: 'Guardar borrador' }))
    await screen.findByText('Otra persona cambió esta publicación.')
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('textbox', { name: 'Título' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Título' })).toHaveValue('Mi edición local')
    expect(JSON.parse(localStorage.getItem(`mozzi:campaign-draft:${tenant}`)!).pending).toBeNull()
  })
})
