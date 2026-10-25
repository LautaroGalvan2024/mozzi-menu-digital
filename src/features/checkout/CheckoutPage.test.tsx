import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkoutBusinessRequest, checkoutRequestFingerprint, getCheckoutAttemptKey, recordCheckoutAttempt } from '../../lib/checkout-attempt'
import type { CartLine } from '../../types/domain'
import { CheckoutPage } from './CheckoutPage'

const PAYMENT = '10000000-0000-4000-8000-000000000001'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), activate: vi.fn(), reconcile: vi.fn(), open: true }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
vi.mock('../../lib/env', () => ({ env: { isTurnstileConfigured: false } }))
const line: CartLine = { key: 'one', productId: '10000000-0000-4000-8000-000000000002', productName: 'Uno', productImagePath: null, quantity: 2, notes: '', unitPriceCents: 1000, quantityPrices: [], selectedOptions: [] }
const payment = { id: PAYMENT, name: 'Efectivo', description: '', adjustmentType: 'none', adjustmentBps: 0, adjustmentScope: 'subtotal', sortOrder: 0 }
vi.mock('../cart/CartProvider', () => ({ useCart: () => ({ restaurantSlug: 'mozzi', lines: [line], subtotalCents: 2000, itemCount: 2, activateRestaurant: mocks.activate, reconcileProducts: mocks.reconcile }) }))
vi.mock('../public-menu/usePublicMenu', () => ({ usePublicMenu: () => ({ isLoading: false, data: {
  restaurant: { id: '10000000-0000-4000-8000-000000000003', slug: 'mozzi', name: 'Mozzi', address: 'Calle Uno', pickupEnabled: true, deliveryEnabled: false, isOpen: mocks.open, minimumOrderCents: 0, whatsappPhone: '+5493492123456', currencyCode: 'ARS', locale: 'es-AR' },
  categories: [], paymentMethods: [payment], deliveryZones: [],
} }) }))

const values = { customerName: 'Ana Pérez', customerPhone: '+5493492123456', fulfillmentType: 'pickup' as const, paymentMethodId: PAYMENT, notes: '', website: '' }
const generated = { order: { actionId: '10000000-0000-4000-8000-000000000004', displayNumber: 'PED-1', status: 'generated', totalCents: 2000, currencyCode: 'ARS', createdAt: '2026-10-24T12:00:00Z' }, whatsapp: { phone: '+5493492123456', message: 'Pedido', url: 'https://wa.me/5493492123456?text=Pedido' }, clientEventToken: null }
function page() {
  return render(<MemoryRouter initialEntries={['/r/mozzi/checkout']}><Routes><Route path="/r/:restaurantSlug/checkout" element={<CheckoutPage />} /><Route path="/r/:restaurantSlug/pedido-generado" element={<p>Pedido recuperado</p>} /></Routes></MemoryRouter>)
}
async function fill(name = values.customerName) {
  await userEvent.type(screen.getByLabelText('Nombre y apellido'), name)
  await userEvent.type(screen.getByLabelText('Teléfono'), values.customerPhone)
}

describe('checkout recovery after an ambiguous response', () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.open = true })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('freezes the original business request and reuses its key on retry, including after closing time', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ data: generated, error: null })
    const view = page()
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Generar pedido' }))
    await screen.findByText(/No pudimos confirmar si el pedido se creó/)
    expect(screen.getByLabelText('Nombre y apellido')).toBeDisabled()
    const first = mocks.invoke.mock.calls[0]![1].body
    const stored = sessionStorage.getItem('mozzi:checkout-attempt:mozzi')!
    expect(stored).not.toContain('Ana')
    expect(stored).not.toContain('5493492123456')
    mocks.open = false
    view.rerender(<MemoryRouter initialEntries={['/r/mozzi/checkout']}><Routes><Route path="/r/:restaurantSlug/checkout" element={<CheckoutPage />} /><Route path="/r/:restaurantSlug/pedido-generado" element={<p>Pedido recuperado</p>} /></Routes></MemoryRouter>)
    await userEvent.click(screen.getByRole('button', { name: 'Recuperar mismo pedido' }))
    await screen.findByText('Pedido recuperado')
    const second = mocks.invoke.mock.calls[1]![1].body
    expect({ ...second, antiSpam: null }).toEqual({ ...first, antiSpam: null })
    expect(sessionStorage.getItem('mozzi:checkout-attempt:mozzi')).toBeNull()
  })

  it('blocks changed customer details after reload and never rotates an expired attempt', async () => {
    const hash = await checkoutRequestFingerprint(checkoutBusinessRequest('mozzi', values, [line]))
    const key = getCheckoutAttemptKey('mozzi', hash, Date.now() - 3 * 60 * 60 * 1000)
    recordCheckoutAttempt('mozzi', key, hash, 'uncertain')
    page()
    await fill('Otra persona')
    await userEvent.click(screen.getByRole('button', { name: 'Recuperar mismo pedido' }))
    await screen.findByText(/Los datos no coinciden con el intento pendiente/)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('mozzi:checkout-attempt:mozzi')!).idempotencyKey).toBe(key)
    expect(screen.getByRole('button', { name: 'Iniciar otro intento' })).toBeDisabled()
  })

  it('recovers identical data after reload with an old key and prevents concurrent submits', async () => {
    const hash = await checkoutRequestFingerprint(checkoutBusinessRequest('mozzi', values, [line]))
    const key = getCheckoutAttemptKey('mozzi', hash, 1000)
    recordCheckoutAttempt('mozzi', key, hash, 'uncertain')
    let resolve!: (result: unknown) => void
    mocks.invoke.mockImplementation(() => new Promise((done) => { resolve = done }))
    page()
    await fill()
    const form = screen.getByRole('button', { name: 'Recuperar mismo pedido' }).closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke.mock.calls[0]![1].body.idempotencyKey).toBe(key)
    resolve({ data: generated, error: null })
    await screen.findByText('Pedido recuperado')
  })

  it('unlocks a definitive first rejection while keeping its key, but not a rejected ambiguous retry', async () => {
    const rejection = () => ({ data: null, error: { context: new Response(JSON.stringify({ error: { code: 'INVENTORY_PAUSED', message: 'internal secret' } }), { status: 409 }) } })
    mocks.invoke.mockResolvedValueOnce(rejection()).mockResolvedValueOnce({ data: {}, error: null }).mockResolvedValueOnce(rejection())
    page()
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Generar pedido' }))
    await screen.findByText(/El comercio pausó temporalmente/)
    expect(screen.getByLabelText('Nombre y apellido')).toBeEnabled()
    const key = mocks.invoke.mock.calls[0]![1].body.idempotencyKey
    await userEvent.click(screen.getByRole('button', { name: 'Generar pedido' }))
    await screen.findByText(/No pudimos confirmar la respuesta/)
    await userEvent.click(screen.getByRole('button', { name: 'Recuperar mismo pedido' }))
    await screen.findByText(/El comercio pausó temporalmente/)
    expect(screen.getByLabelText('Nombre y apellido')).toBeDisabled()
    expect(mocks.invoke.mock.calls.every(([, input]) => input.body.idempotencyKey === key)).toBe(true)
    expect(screen.queryByText('internal secret')).not.toBeInTheDocument()
  })

  it('requires explicit merchant confirmation to replace an ambiguous attempt without clearing the entered fields', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({ data: generated, error: null })
    page()
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Generar pedido' }))
    await screen.findByText(/No pudimos confirmar si el pedido se creó/)
    const previousKey = mocks.invoke.mock.calls[0]![1].body.idempotencyKey
    expect(screen.getByRole('button', { name: 'Iniciar otro intento' })).toBeDisabled()
    await userEvent.click(screen.getByLabelText('Ya confirmé con el comercio que el pedido anterior no existe.'))
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar otro intento' }))
    expect(screen.getByLabelText('Nombre y apellido')).toHaveValue('Ana Pérez')
    expect(screen.getByLabelText('Nombre y apellido')).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Generar pedido' }))
    await screen.findByText('Pedido recuperado')
    expect(mocks.invoke.mock.calls[1]![1].body.idempotencyKey).not.toBe(previousKey)
  })
})
