import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateRestaurantPage } from './CreateRestaurantPage'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), navigate: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
vi.mock('react-router', async importOriginal => ({ ...await importOriginal<typeof import('react-router')>(), useNavigate: () => mocks.navigate }))

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={client}><MemoryRouter><CreateRestaurantPage /></MemoryRouter></QueryClientProvider>)
  return { details: screen.getByText('Opciones del comercio').closest('details')! }
}

function completeIdentity() {
  const fixture: [string | RegExp, string][] = [
    ['Nombre interno', 'Casa Móvil interna'], ['Nombre comercial', 'Casa Móvil'],
    [/^Dirección del link/, 'casa-movil'], [/^WhatsApp/, '+5493492123456'],
    ['Dirección', 'San Martín 123'], ['Ciudad', 'Rafaela'],
    ['Nombre completo', 'Agustina Comercial'], ['Correo', 'administracion@example.invalid'],
  ]
  for (const [label, value] of fixture) fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('CreateRestaurantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue({ data: { restaurant: { id: '71000000-0000-4000-8000-000000000001' } }, error: null })
  })
  afterEach(cleanup)

  it('keeps optional settings collapsed and creates with the existing operational defaults', async () => {
    const user = userEvent.setup()
    const { details } = show()
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByRole('heading', { name: 'Identidad' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Primer administrador' })).toBeVisible()
    completeIdentity()
    await user.click(screen.getByRole('button', { name: 'Crear e invitar' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).toHaveBeenCalledWith('create-restaurant', { body: expect.objectContaining({
      currencyCode: 'ARS', minimumOrderCents: 0, initialDeliveryFeeCents: 0, defaultPreparationMinutes: 30,
      deliveryEnabled: true, pickupEnabled: true, timezone: 'America/Argentina/Cordoba',
      administrator: { fullName: 'Agustina Comercial', email: 'administracion@example.invalid' },
    }) })
    expect(details).not.toHaveAttribute('open')
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/superadmin/restaurantes/71000000-0000-4000-8000-000000000001', { replace: true }))
  })

  it('uses the selected currency in labels and converts major units to cents only in the request', async () => {
    const user = userEvent.setup()
    show()
    completeIdentity()
    await user.click(screen.getByText('Opciones del comercio'))
    await user.clear(screen.getByLabelText('Moneda'))
    await user.type(screen.getByLabelText('Moneda'), 'USD')
    const minimum = screen.getByLabelText('Pedido mínimo (USD)')
    const delivery = screen.getByLabelText('Envío inicial (USD)')
    await user.clear(minimum)
    await user.type(minimum, '1500.50')
    await user.clear(delivery)
    await user.type(delivery, '125,75')
    await user.click(screen.getByRole('button', { name: 'Crear e invitar' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).toHaveBeenCalledWith('create-restaurant', { body: expect.objectContaining({
      currencyCode: 'USD', minimumOrderCents: 150050, initialDeliveryFeeCents: 12575,
    }) })
    expect(minimum).toHaveValue('1500.50')
    expect(delivery).toHaveValue('125,75')
  })

  it('reopens optional settings and focuses a hidden invalid amount without sending a request', async () => {
    const user = userEvent.setup()
    const { details } = show()
    completeIdentity()
    await user.click(screen.getByText('Opciones del comercio'))
    const amount = screen.getByLabelText('Pedido mínimo (ARS)')
    await user.clear(amount)
    await user.type(amount, '1500.501')
    await user.click(screen.getByText('Opciones del comercio'))
    expect(details).not.toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'Crear e invitar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Ingresá un importe válido, desde 0 y con hasta 2 decimales.')
    expect(details).toHaveAttribute('open')
    expect(amount).toHaveFocus()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await user.clear(amount)
    await user.type(amount, '1500,50')
    await user.click(screen.getByRole('button', { name: 'Crear e invitar' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke).toHaveBeenCalledWith('create-restaurant', { body: expect.objectContaining({ minimumOrderCents: 150050 }) })
  })
})
