import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readOrderRecovery, saveOrderRecovery } from '../../lib/order-recovery'
import type { GeneratedOrder } from '../../types/domain'
import { OrderGeneratedPage } from './OrderGeneratedPage'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), clear: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
vi.mock('../cart/CartProvider', () => ({ useCart: () => ({ clear: mocks.clear }) }))
const actionId = '10000000-0000-4000-8000-000000000004'
function result(): GeneratedOrder {
  return { order: { actionId, displayNumber: 'PED-1', status: 'generated', totalCents: 2200, currencyCode: 'ARS', createdAt: '2026-10-24T12:00:00Z' },
    whatsapp: { phone: '+5493492000000', message: 'Ana Pérez\n2 × Arroz\nTotal: $22', url: 'https://wa.me/5493492000000?text=Pedido' },
    clientEventToken: null, idempotentReplay: false, recoveryToken: 'r'.repeat(43), recoveryExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), estimatedTotalCents: 2200 }
}
function page(state: GeneratedOrder | null = null) {
  return render(<MemoryRouter initialEntries={[{ pathname: '/r/mozzi/pedido-generado', state }]}><Routes><Route path="/r/:restaurantSlug/pedido-generado" element={<OrderGeneratedPage />} /></Routes></MemoryRouter>)
}

describe('temporary order confirmation recovery', () => {
  beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.clear.mockReset() })
  afterEach(cleanup)
  it('persists only the read capability and quote, and lets the customer remove them', async () => {
    const user = userEvent.setup(); page(result())
    expect(await screen.findByText('PED-1')).toBeVisible()
    const saved = localStorage.getItem('mozzi:order-confirmation:mozzi')!
    expect(saved).toContain(actionId)
    expect(saved).not.toContain('Ana')
    expect(saved).not.toContain('Arroz')
    expect(saved).not.toContain('5493492000000')
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Quitar acceso guardado en este dispositivo' }))
    expect(readOrderRecovery('mozzi')).toBeNull()
  })
  it('recovers on reload without creating another order or clearing a newer cart', async () => {
    const data = result(); saveOrderRecovery('mozzi', data)
    mocks.invoke.mockResolvedValueOnce({ data: { ...data, idempotentReplay: true }, error: null })
    page()
    expect(await screen.findByText('PED-1')).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledWith('recover-order', { body: { actionId, recoveryToken: data.recoveryToken } })
    expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('requires review before sharing a total different from the original quote', async () => {
    const user = userEvent.setup(); page({ ...result(), estimatedTotalCents: 2000 })
    expect(await screen.findByRole('alert')).toHaveTextContent('El total cambió')
    expect(screen.getByRole('button', { name: 'Abrir WhatsApp' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copiar mensaje' })).toBeDisabled()
    expect(screen.getByText('Abrir WhatsApp Web').closest('a')).not.toHaveAttribute('href')
    expect(screen.getByText(/Ana Pérez/)).toBeVisible()
    await user.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Copiar mensaje' })).toBeEnabled()
    expect(screen.getByText('Abrir WhatsApp Web').closest('a')).toHaveAttribute('href')
  })
  it('never recovers through a UUID alone or exposes a mismatched result', async () => {
    saveOrderRecovery('mozzi', result())
    const other = result(); other.order = { ...other.order, actionId: '20000000-0000-4000-8000-000000000004' }
    mocks.invoke.mockResolvedValueOnce({ data: other, error: null })
    page()
    expect(await screen.findByText(/La respuesta no pudo verificarse/)).toBeVisible()
    expect(screen.queryByText(/Ana Pérez/)).not.toBeInTheDocument()
    expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('retries a failed read with the same capability and does not recreate the order', async () => {
    const user = userEvent.setup(); saveOrderRecovery('mozzi', result())
    mocks.invoke.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ data: result(), error: null })
    page(); await screen.findByRole('button', { name: 'Reintentar recuperación' })
    await user.click(screen.getByRole('button', { name: 'Reintentar recuperación' }))
    await screen.findByText('PED-1')
    expect(mocks.invoke.mock.calls[1]).toEqual(mocks.invoke.mock.calls[0])
  })
  it('expires local references and does not request another tenant or an expired token', async () => {
    const data = result(); data.recoveryExpiresAt = '2000-01-01T00:00:00Z'; saveOrderRecovery('mozzi', data)
    saveOrderRecovery('otro-comercio', result())
    page(); await screen.findByText('Esta confirmación no está disponible')
    await waitFor(() => expect(mocks.invoke).not.toHaveBeenCalled())
    expect(readOrderRecovery('mozzi')).toBeNull()
    expect(readOrderRecovery('otro-comercio')).not.toBeNull()
  })
})
