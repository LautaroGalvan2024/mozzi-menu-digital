import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MercadoPagoSettings } from './MercadoPagoSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }))
const restaurantId = '10000000-0000-4000-8000-000000000001'
function configured(environment: 'test' | 'production', accountEnvironment: 'test' | 'production' | null = environment) {
  return { configured: true, configurationIssue: null, environment, connectionEnvironment: accountEnvironment, readyForPayments: environment === accountEnvironment, connectionIssue: environment === accountEnvironment ? null : 'different_environment', connection: { connected: true, active: true, providerUserId: '12345' } }
}
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
    expect(screen.getByText('Ambiente sin verificar')).toBeVisible()
    expect(screen.queryByText('Cuenta lista para cobros reales')).not.toBeInTheDocument()
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

  it('requires explicit reconnection when a test authorization is used in production', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: configured('production', 'test'), error: null }).mockResolvedValueOnce({ data: null, error: new Error('Synthetic authorization failure') })
    view()
    expect(await screen.findByText('Cobros reales')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Necesita reconexión')
    expect(screen.getByText(/Autorización actual: prueba/)).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('La conexión de prueba no se convierte automáticamente')
    expect(screen.queryByText('Cuenta lista para cobros reales')).not.toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Reconectar cuenta para cobros reales' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('mercadopago-connect', { body: { restaurantId, action: 'connect' } }))
  })

  it('distinguishes test readiness from real payments', async () => {
    mocks.invoke.mockResolvedValue({ data: configured('test'), error: null })
    view()
    expect(await screen.findByText('Modo prueba')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Cuenta lista para pruebas')
    expect(screen.getByText(/Las compras de prueba no generan cobros reales/)).toBeVisible()
    expect(screen.queryByText('Cuenta lista para cobros reales')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconectar Mercado Pago para pruebas' })).toBeEnabled()
  })

  it('shows production authorization separately from the inventory and store activation steps', async () => {
    mocks.invoke.mockResolvedValue({ data: configured('production'), error: null })
    view()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cuenta lista para cobros reales'))
    expect(screen.getByText(/Autorización actual: cobros reales/)).toBeVisible()
    const steps = screen.getByRole('list', { name: 'Pasos para habilitar pagos online' })
    expect(steps).toHaveTextContent('Activá el control desde Stock')
    expect(steps).toHaveTextContent('Pagos online con Mercado Pago')
    expect(screen.getByText(/no necesitás copiar claves/)).toBeVisible()
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mercadopago-connect', { body: { restaurantId, action: 'status' } })
  })

  it.each(['inactive', 'reconnect_required'] as const)('explains a %s connection without claiming it is ready', async issue => {
    mocks.invoke.mockResolvedValue({ data: { ...configured('production'), readyForPayments: false, connectionIssue: issue, connection: { connected: issue !== 'inactive', active: issue !== 'inactive' } }, error: null })
    view()
    expect(await screen.findByRole('alert')).toHaveTextContent(issue === 'inactive' ? 'Los nuevos cobros están desactivados.' : 'Esta autorización necesita renovarse')
    expect(screen.queryByText('Cuenta lista para cobros reales')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconectar cuenta para cobros reales' })).toBeEnabled()
  })

  it('offers the first production connection for this commerce without collecting credentials', async () => {
    mocks.invoke.mockResolvedValue({ data: { ...configured('production'), connection: { connected: false }, connectionEnvironment: null, readyForPayments: false, connectionIssue: 'not_connected' }, error: null })
    view()
    expect(await screen.findByRole('button', { name: 'Conectar mi cuenta para cobros reales' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('Sin conexión')
    expect(screen.queryByText(/Autorización actual:/)).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Desactivar nuevos cobros' })).not.toBeInTheDocument()
  })

  it('never presents an incompatible environment as ready even if the readiness flag is inconsistent', async () => {
    mocks.invoke.mockResolvedValue({ data: { ...configured('production', 'test'), readyForPayments: true }, error: null })
    view()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Necesita reconexión'))
    expect(screen.queryByText('Cuenta lista para cobros reales')).not.toBeInTheDocument()
  })

  it('lets an administrator retry a failed status lookup without starting OAuth', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('Synthetic query failure') }).mockResolvedValueOnce({ data: configured('production'), error: null })
    view()
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos consultar la conexión de Mercado Pago.')
    expect(screen.getByRole('button', { name: 'Conectar Mercado Pago' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar estado' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cuenta lista para cobros reales'))
    expect(mocks.invoke.mock.calls).toEqual([
      ['mercadopago-connect', { body: { restaurantId, action: 'status' } }],
      ['mercadopago-connect', { body: { restaurantId, action: 'status' } }],
    ])
  })
})
