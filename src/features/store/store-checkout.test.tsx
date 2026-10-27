import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckoutPage } from '../checkout/CheckoutPage'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), clear: vi.fn(), activate: vi.fn(), reconcile: vi.fn(), whatsappEnabled: false }))
vi.mock('../../lib/env', () => ({ env: { isTurnstileConfigured: false } }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
const line = { key: '10000000-0000-4000-8000-000000000001', productId: '10000000-0000-4000-8000-000000000002', productName: 'Funda roja', productImagePath: null, quantity: 1, notes: '', unitPriceCents: 1000, quantityPrices: [], selectedOptions: [] }
vi.mock('../cart/CartProvider', () => ({ useCart: () => ({ channel: 'store', restaurantSlug: 'fundas', lines: [line], subtotalCents: 1000, itemCount: 1, activateRestaurant: mocks.activate, reconcileProducts: mocks.reconcile, clear: mocks.clear }) }))
vi.mock('../public-menu/usePublicMenu', () => ({ usePublicMenu: () => ({ isLoading: false, data: {
  restaurant: { id: '10000000-0000-4000-8000-000000000003', slug: 'fundas', name: 'Fundas', address: 'Calle Uno', pickupEnabled: true, deliveryEnabled: false, isOpen: false, acceptsOrders: true, storeCheckoutWhatsappEnabled: mocks.whatsappEnabled, storeCheckoutOnlineEnabled: true, minimumOrderCents: 0, whatsappPhone: '+5493492123456', currencyCode: 'ARS', locale: 'es-AR' },
  categories: [{ products: [{ id: line.productId, available: true, optionGroups: [] }] }], paymentMethods: [], deliveryZones: [],
} }) }))
const session = { order: { actionId: '10000000-0000-4000-8000-000000000004', displayNumber: 'PED-1', status: 'generated', totalCents: 1000, currencyCode: 'ARS', createdAt: '2026-10-27T12:00:00Z' }, payment: { status: 'pending', checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123', expiresAt: '2099-10-27T12:30:00Z' }, recoveryToken: 'a'.repeat(43), recoveryExpiresAt: '2099-11-27T12:00:00Z' }
function Confirmation() { const location = useLocation(); return <p>Pago preparado: {location.state.order.displayNumber}</p> }
function page() { return render(<MemoryRouter initialEntries={['/t/fundas/checkout']}><Routes><Route path="/t/:restaurantSlug/checkout" element={<CheckoutPage />} /><Route path="/t/:restaurantSlug/pago" element={<Confirmation />} /></Routes></MemoryRouter>) }
async function fill() { await userEvent.type(screen.getByLabelText('Nombre y apellido'), 'Ana Pérez'); await userEvent.type(screen.getByLabelText('Teléfono'), '+5493492123456') }

describe('store online checkout', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); mocks.whatsappEnabled = false })
  afterEach(cleanup)
  it('can receive online purchases outside business hours without manual payment methods', async () => {
    mocks.invoke.mockResolvedValue({ data: session, error: null })
    page(); await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Continuar al pago' }))
    expect(await screen.findByText('Pago preparado: PED-1')).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('create-payment', expect.objectContaining({ body: expect.objectContaining({ channel: 'store', checkoutMode: 'online' }) }))
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(localStorage.getItem('mozzi:payment-confirmation:store:fundas')).toContain(session.order.actionId)
    expect(sessionStorage.getItem('mozzi:checkout-attempt:store:fundas')).toBeNull()
  })
  it('reuses the same key after an ambiguous provider failure and never opens a new purchase', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: 'internal' } }), { status: 503 }) } }).mockResolvedValueOnce({ data: session, error: null })
    page(); await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Continuar al pago' }))
    await screen.findByText(/Mercado Pago no respondió/)
    expect(screen.getByLabelText('Nombre y apellido')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Recuperar mismo pedido' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2))
    expect(mocks.invoke.mock.calls[0]![1].body.idempotencyKey).toBe(mocks.invoke.mock.calls[1]![1].body.idempotencyKey)
  })
  it('restores the online mode after reloading a pending attempt even when WhatsApp is the default', async () => {
    mocks.whatsappEnabled = true
    mocks.invoke.mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ data: session, error: null })
    const first = page(); await fill()
    await userEvent.click(screen.getByRole('radio', { name: /Pagar online/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continuar al pago' }))
    await screen.findByText(/No pudimos confirmar si el pedido se creó/)
    const original = mocks.invoke.mock.calls[0]![1].body
    first.unmount()
    page(); await fill()
    expect(screen.getByRole('radio', { name: /Pagar online/ })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Recuperar mismo pedido' }))
    await screen.findByText('Pago preparado: PED-1')
    expect(mocks.invoke.mock.calls[1]![0]).toBe('create-payment')
    expect(mocks.invoke.mock.calls[1]![1].body.idempotencyKey).toBe(original.idempotencyKey)
  })
})
