import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentStatusPage } from './PaymentStatusPage'
import { paymentSessionSchema, savePaymentRecovery } from './payment-recovery'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
const session = { order: { actionId: '10000000-0000-4000-8000-000000000001', displayNumber: 'PED-1', status: 'generated', totalCents: 2000, currencyCode: 'ARS', createdAt: '2026-10-27T12:00:00Z' }, payment: { status: 'pending', checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123', expiresAt: '2099-10-27T12:30:00Z' }, recoveryToken: 'a'.repeat(43), recoveryExpiresAt: '2099-11-27T12:00:00Z' }
function page() { return render(<MemoryRouter initialEntries={['/t/fundas/pago?status=approved&payment_id=evil']}><Routes><Route path="/t/:restaurantSlug/pago" element={<PaymentStatusPage />} /></Routes></MemoryRouter>) }

describe('payment confirmation trust boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })
  afterEach(cleanup)
  it('never accepts a success query as proof or requests an order without its read capability', async () => {
    page()
    expect(await screen.findByText('Acceso no disponible')).toBeVisible()
    expect(screen.queryByText('Pago aprobado')).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('uses the stored capability and displays the provider-verified state', async () => {
    savePaymentRecovery('fundas', session)
    mocks.invoke.mockResolvedValue({ data: session, error: null })
    page()
    expect(await screen.findByRole('heading', { name: 'Pago pendiente' })).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('payment-status', { body: { actionId: session.order.actionId, recoveryToken: session.recoveryToken } })
    expect(screen.queryByText('Pago aprobado')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Pagar en Mercado Pago' })).toHaveAttribute('href', session.payment.checkoutUrl))
  })
  it('rejects untrusted redirect targets and stores no customer details', () => {
    expect(paymentSessionSchema.safeParse({ ...session, payment: { ...session.payment, checkoutUrl: 'https://mercadopago.com.ar.evil.example/checkout' } }).success).toBe(false)
    savePaymentRecovery('fundas', session)
    expect(JSON.parse(localStorage.getItem('mozzi:payment-confirmation:store:fundas')!)).toEqual({ actionId: session.order.actionId, token: session.recoveryToken, expiresAt: session.recoveryExpiresAt })
  })
})
