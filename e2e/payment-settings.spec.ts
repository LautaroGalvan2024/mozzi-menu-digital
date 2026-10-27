import { expect, test, type Page } from '@playwright/test'

const restaurantId = '31000000-0000-4000-8000-000000000001'
const userId = '32000000-0000-4000-8000-000000000001'
const restaurant = {
  id: restaurantId, name: 'Casa Móvil', trade_name: 'Casa Móvil', slug: 'casa-movil', description: '', status: 'active',
  whatsapp_phone_e164: '+5493492123456', address: 'San Martín 123', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR',
  logo_path: null, cover_path: null, primary_color: '#4338ca', secondary_color: '#e0e7ff', delivery_enabled: true, pickup_enabled: true,
  minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: true, updated_at: new Date().toISOString(),
}

async function adminFixture(page: Page, status: Record<string, unknown>) {
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'admin@example.invalid', app_metadata: {}, user_metadata: {}, factors: [], created_at: new Date().toISOString() }
  // Synthetic local session. Every provider request is intercepted; there are no real credentials.
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp: expiresAt })).toString('base64url'),
    Buffer.from('synthetic-e2e-signature').toString('base64url'),
  ].join('.')
  await page.addInitScript(({ session, selected }) => {
    localStorage.setItem('sb-e2e-auth-token', JSON.stringify(session))
    localStorage.setItem('mozzi:selected-restaurant', selected)
  }, { session: { access_token: accessToken, refresh_token: 'synthetic-e2e-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user }, selected: restaurantId })
  await page.routeWebSocket('wss://e2e.invalid/**', socket => socket.close())
  const unexpected: string[] = []
  const paymentRequests: unknown[] = []
  await page.route('https://e2e.invalid/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let body: unknown
    if (request.method() === 'GET' && path === '/auth/v1/user') body = user
    else if (request.method() === 'GET' && path === '/rest/v1/profiles') body = { id: userId, full_name: 'Administración Casa Móvil', email: user.email, active: true }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurant_members') body = [{ id: '33000000-0000-4000-8000-000000000001', restaurant_id: restaurantId, role: 'restaurant_admin', status: 'active', restaurants: restaurant }]
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_actor_authorization') body = { userId, isSuperAdmin: false, aal: 'aal1', memberships: [{ restaurantId, role: 'restaurant_admin', status: 'active' }] }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurants') body = restaurant
    else if (request.method() === 'GET' && path === '/rest/v1/payment_methods') body = []
    else if (request.method() === 'POST' && path === '/functions/v1/mercadopago-connect' && request.postDataJSON().action === 'status') {
      paymentRequests.push(request.postDataJSON())
      body = status
    } else {
      unexpected.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected mocked request' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { unexpected, paymentRequests }
}

test.describe('Mercado Pago environment settings', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'This suite uses only the isolated e2e.invalid mock environment.')

  test('mobile explains an inactive test authorization in production without claiming readiness', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const requests = await adminFixture(page, {
      configured: true, configurationIssue: null, environment: 'production', connectionEnvironment: 'test', readyForPayments: false,
      connectionIssue: 'different_environment', connection: { connected: false, providerUserId: '12345', expiresAt: '2030-01-01T00:00:00Z' },
    })
    await page.goto('/admin/medios-de-pago')
    const section = page.getByRole('region', { name: 'Mercado Pago para tu tienda' })
    await expect(section.getByText('Cobros reales', { exact: true })).toBeVisible()
    await expect(section.getByRole('status')).toHaveText('Necesita reconexión')
    await expect(section.getByRole('status')).not.toHaveClass(/emerald/)
    await expect(section.getByText(/Autorización actual: prueba/)).toBeVisible()
    await expect(section.getByRole('alert')).toContainText('La conexión de prueba no se convierte automáticamente')
    await expect(section.getByRole('button', { name: 'Reconectar cuenta para cobros reales' })).toBeEnabled()
    await expect(section.getByText('Cuenta lista para cobros reales', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('payment-settings-mismatch-mobile.png'), fullPage: true })
    expect(requests.paymentRequests).toEqual([{ restaurantId, action: 'status' }])
    expect(requests.unexpected).toEqual([])
  })

  test('a new commerce can connect its first production account without being asked to reconnect', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const requests = await adminFixture(page, {
      configured: true, configurationIssue: null, environment: 'production', connectionEnvironment: null, readyForPayments: false,
      connectionIssue: 'not_connected', connection: { connected: false },
    })
    await page.goto('/admin/medios-de-pago')
    const section = page.getByRole('region', { name: 'Mercado Pago para tu tienda' })
    await expect(section.getByRole('button', { name: 'Conectar mi cuenta para cobros reales' })).toBeEnabled()
    await expect(section.getByRole('status')).toHaveText('Sin conexión')
    await expect(section.getByRole('button', { name: /Reconectar/ })).toHaveCount(0)
    await expect(section.getByText(/Autorización actual:/)).toHaveCount(0)
    await expect(section.getByRole('textbox')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(requests.paymentRequests).toEqual([{ restaurantId, action: 'status' }])
    expect(requests.unexpected).toEqual([])
  })

  test('desktop shows a ready production account and the separate inventory and store activation steps', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const requests = await adminFixture(page, {
      configured: true, configurationIssue: null, environment: 'production', connectionEnvironment: 'production', readyForPayments: true,
      connectionIssue: null, connection: { connected: true, providerUserId: '12345', expiresAt: '2030-01-01T00:00:00Z' },
    })
    await page.goto('/admin/medios-de-pago')
    const section = page.getByRole('region', { name: 'Mercado Pago para tu tienda' })
    await expect(section.getByRole('status')).toHaveText('Cuenta lista para cobros reales')
    await expect(section.getByRole('status')).toHaveClass(/text-emerald-800/)
    await expect(section.getByText(/Autorización actual: cobros reales/)).toBeVisible()
    const steps = section.getByRole('list', { name: 'Pasos para habilitar pagos online' })
    await expect(steps).toContainText('Activá el control desde Stock')
    await expect(steps).toContainText('Pagos online con Mercado Pago')
    await expect(section.getByText(/no necesitás copiar claves/)).toBeVisible()
    await expect(section.getByRole('button', { name: 'Desactivar nuevos cobros' })).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('payment-settings-ready-desktop.png'), fullPage: true })
    expect(requests.paymentRequests).toEqual([{ restaurantId, action: 'status' }])
    expect(requests.unexpected).toEqual([])
  })
})
