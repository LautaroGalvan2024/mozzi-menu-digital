import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MercadoPagoSettings } from './MercadoPagoSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
const restaurantId = '10000000-0000-4000-8000-000000000001'
function view() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MercadoPagoSettings restaurantId={restaurantId} /></QueryClientProvider>)
}

describe('Mercado Pago connection configuration', () => {
  beforeEach(() => mocks.invoke.mockReset())
  afterEach(cleanup)

  it('explains an invalid application ID and never attempts OAuth while unconfigured', async () => {
    mocks.invoke.mockResolvedValue({ data: { configured: false, configurationIssue: 'invalid_client_id', connection: null }, error: null })
    const user = userEvent.setup()
    view()
    expect(await screen.findByRole('alert')).toHaveTextContent('El ID de la aplicación de Mercado Pago debe ser numérico. El administrador de Mozzi debe corregirlo para conectar la cuenta.')
    const button = screen.getByRole('button', { name: 'Conectar Mercado Pago' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mercadopago-connect', { body: { restaurantId, action: 'status' } })
  })

  it.each(['omitted', 'null'] as const)('accepts a configured response with configurationIssue %s', async mode => {
    const data = { configured: true, connection: { active: true }, ...(mode === 'null' ? { configurationIssue: null } : {}) }
    mocks.invoke.mockResolvedValueOnce({ data, error: null }).mockResolvedValueOnce({ data: null, error: new Error('Synthetic authorization failure') })
    const user = userEvent.setup()
    view()
    await screen.findByText('Cuenta conectada')
    const button = screen.getByRole('button', { name: 'Reconectar Mercado Pago' })
    expect(button).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(button)
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('mercadopago-connect', { body: { restaurantId, action: 'connect' } }))
  })

  it('keeps the previous unconfigured response compatible and blocked', async () => {
    mocks.invoke.mockResolvedValue({ data: { configured: false, connection: null }, error: null })
    view()
    expect(await screen.findByRole('alert')).toHaveTextContent('La conexión de pagos todavía no está configurada en la plataforma.')
    expect(screen.getByRole('button', { name: 'Conectar Mercado Pago' })).toBeDisabled()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })
})
