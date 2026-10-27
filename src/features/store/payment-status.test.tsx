import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentStatusPage } from './PaymentStatusPage'
import { paymentSessionSchema, savePaymentRecovery, type PaymentStatus } from './payment-recovery'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
const session = { order: { actionId: '10000000-0000-4000-8000-000000000001', displayNumber: 'PED-1', status: 'generated', totalCents: 2000, currencyCode: 'ARS', createdAt: '2026-10-27T12:00:00Z' }, payment: { status: 'pending', checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123', expiresAt: '2099-10-27T12:30:00Z' }, recoveryToken: 'a'.repeat(43), recoveryExpiresAt: '2099-11-27T12:00:00Z' }
function page() { return render(<MemoryRouter initialEntries={['/t/fundas/pago?status=approved&payment_id=evil']}><Routes><Route path="/t/:restaurantSlug/pago" element={<PaymentStatusPage />} /></Routes></MemoryRouter>) }
function verifiedResult(payment: Partial<PaymentStatus['payment']>, order: Partial<PaymentStatus['order']> = {}) {
  const result = { ...session, order: { ...session.order, ...order }, payment: { ...session.payment, ...payment } }
  savePaymentRecovery('fundas', session)
  mocks.invoke.mockResolvedValue({ data: result, error: null })
  return result
}
const whatsappMessage = 'En breve, el comercio se comunicará por WhatsApp al número que ingresaste para darte los detalles de tu pedido.'

describe('payment confirmation trust boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })
  afterEach(() => { cleanup(); vi.useRealTimers() })
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
    expect(await screen.findByRole('heading', { name: 'Pago pendiente de confirmación' })).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('payment-status', { body: { actionId: session.order.actionId, recoveryToken: session.recoveryToken } })
    expect(screen.queryByText('Pago aprobado')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Continuar en Mercado Pago' })).toHaveAttribute('href', session.payment.checkoutUrl))
    expect(screen.getByText('Si ya pagaste, esperá la confirmación')).toBeVisible()
    expect(screen.getByText('Sólo si todavía no completaste el pago.')).toBeVisible()
  })
  it('rejects untrusted redirect targets and stores no customer details', () => {
    expect(paymentSessionSchema.safeParse({ ...session, payment: { ...session.payment, checkoutUrl: 'https://mercadopago.com.ar.evil.example/checkout' } }).success).toBe(false)
    savePaymentRecovery('fundas', session)
    expect(JSON.parse(localStorage.getItem('mozzi:payment-confirmation:store:fundas')!)).toEqual({ actionId: session.order.actionId, token: session.recoveryToken, expiresAt: session.recoveryExpiresAt })
  })
  it('keeps recovery isolated to the commerce and rejects expired access', async () => {
    savePaymentRecovery('another-store', session)
    savePaymentRecovery('fundas', { ...session, recoveryExpiresAt: '2000-01-01T00:00:00Z' })
    page()
    expect(await screen.findByText('Acceso no disponible')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('explains WhatsApp follow-up for a paid order without inventing employee acceptance', async () => {
    verifiedResult({ status: 'approved' })
    page()
    expect(await screen.findByRole('heading', { name: 'Pago aprobado' })).toBeVisible()
    expect(screen.getByText(whatsappMessage)).toBeVisible()
    expect(screen.getByText('Si compraste fuera del horario de atención, te contactarán cuando el comercio vuelva a abrir.')).toBeVisible()
    expect(screen.getByText('Pendiente de confirmación del comercio')).toBeVisible()
    expect(screen.getByText('PED-1')).toBeVisible()
    expect(screen.getByText('Total de la compra')).toBeVisible()
    expect(screen.queryByText(/preparará|Aceptado por el comercio/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
  })
  it.each([
    ['created', 'Pago por iniciar'],
    ['pending', 'Pago pendiente de confirmación'],
    ['in_process', 'Pago en revisión'],
    ['rejected', 'Pago rechazado'],
    ['cancelled', 'Pago cancelado'],
  ])('does not promise merchant contact for %s payments', async (status, title) => {
    verifiedResult({ status })
    page()
    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
    expect(screen.queryByText(whatsappMessage)).not.toBeInTheDocument()
    expect(screen.queryByText(/preparará/)).not.toBeInTheDocument()
  })
  it('separates cancellation of a paid order from a refund', async () => {
    verifiedResult({ status: 'approved' }, { status: 'cancelled' })
    page()
    expect(await screen.findByRole('heading', { name: 'Pedido cancelado' })).toBeVisible()
    expect(screen.getByText('El pago figura aprobado, pero el pedido fue cancelado.')).toBeVisible()
    expect(screen.getByText(/Cancelar el pedido no devuelve el dinero automáticamente/)).toBeVisible()
    expect(screen.queryByText(whatsappMessage)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pago devuelto' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
  })
  it('shows delivered purchases without promising another contact', async () => {
    verifiedResult({ status: 'approved' }, { status: 'completed' })
    page()
    expect(await screen.findByRole('heading', { name: 'Compra entregada' })).toBeVisible()
    expect(screen.getByText('El comercio marcó tu pedido como entregado.')).toBeVisible()
    expect(screen.queryByText(whatsappMessage)).not.toBeInTheDocument()
  })
  it.each([
    ['refunded', false, 'Pago devuelto'],
    ['partially_refunded', true, 'Pago devuelto parcialmente'],
    ['requires_refund', true, 'Tu compra necesita atención'],
    ['charged_back', true, 'Pago en disputa'],
    ['approved', true, 'Tu compra necesita atención'],
  ])('does not promise fulfillment or repeat payment for %s under review=%s', async (status, reviewRequired, title) => {
    verifiedResult({ status, reviewRequired })
    page()
    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
    expect(screen.queryByText(whatsappMessage)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
  })
  it('blocks the old payment link when the order was cancelled', async () => {
    verifiedResult({ status: 'pending' }, { status: 'cancelled' })
    page()
    expect(await screen.findByRole('heading', { name: 'Pedido cancelado' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
  })
  it('removes the payment link when its validity expires while the page stays open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    verifiedResult({ expiresAt: '2026-10-27T12:00:01Z' })
    await act(async () => { page() })
    expect(screen.getByRole('link', { name: 'Continuar en Mercado Pago' })).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
    expect(screen.getByRole('heading', { name: 'El plazo de pago venció' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
  })
  it('polls pending purchases and only announces approval returned by the server', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    verifiedResult({ status: 'pending' })
    await act(async () => { page() })
    mocks.invoke.mockResolvedValue({ data: { ...session, payment: { ...session.payment, status: 'approved' } }, error: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('heading', { name: 'Pago aprobado' })).toBeVisible()
    expect(screen.getByText(whatsappMessage)).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })
  it('retains recovery and manual refresh after a query failure without offering a duplicate payment', async () => {
    verifiedResult({ status: 'pending' })
    page()
    await screen.findByRole('heading', { name: 'Pago pendiente de confirmación' })
    mocks.invoke.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } })
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }))
    expect(await screen.findByText('No pudimos actualizar el estado')).toBeVisible()
    expect(screen.getByText(/El resumen muestra la última información disponible/)).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Continuar en Mercado Pago' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Actualizar estado' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }))
    expect(await screen.findByRole('link', { name: 'Continuar en Mercado Pago' })).toHaveAttribute('href', session.payment.checkoutUrl)
    expect(mocks.invoke).toHaveBeenLastCalledWith('payment-status', { body: { actionId: session.order.actionId, recoveryToken: session.recoveryToken } })
  })
  it('rejects a response belonging to another order even if its payment is approved', async () => {
    verifiedResult({ status: 'approved' }, { actionId: '10000000-0000-4000-8000-000000000002' })
    page()
    expect(await screen.findByText(/No pudimos verificar la respuesta del pago/)).toBeVisible()
    expect(screen.queryByText(whatsappMessage)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pago aprobado' })).not.toBeInTheDocument()
  })
})
