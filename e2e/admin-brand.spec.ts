import { expect, test, type Page } from '@playwright/test'

const commerceId = '71000000-0000-4000-8000-000000000001'
const otherCommerceId = '71000000-0000-4000-8000-000000000002'
const userId = '72000000-0000-4000-8000-000000000001'
const staffId = '72000000-0000-4000-8000-000000000002'
type Account = 'anonymous' | 'admin' | 'multi' | 'super'

async function readOnlyFixture(page: Page, account: Account, assurance: 'aal1' | 'aal2' = account === 'super' ? 'aal2' : 'aal1') {
  const timestamp = '2026-10-27T12:00:00Z'
  const restaurant = {
    id: commerceId, name: 'Casa Móvil', trade_name: 'Casa Móvil', slug: 'casa-movil', description: 'Accesorios para todos tus días.', status: 'active',
    whatsapp_phone_e164: '+5493492123456', address: 'San Martín 123', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR',
    logo_path: null, cover_path: null, primary_color: '#bf4a25', secondary_color: '#17212f', delivery_enabled: true, pickup_enabled: true,
    minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: true, store_ordering_policy: 'always',
    store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false, inventory_mode: 'enforced', inventory_cutover_id: null, updated_at: timestamp,
  }
  const restaurants = [restaurant, { ...restaurant, id: otherCommerceId, name: 'Almacén del Centro', trade_name: 'Almacén del Centro', slug: 'almacen-centro' }]
  const memberships = restaurants.map((row, index) => ({ id: `73000000-0000-4000-8000-00000000000${index + 1}`, user_id: userId, restaurant_id: row.id, role: 'restaurant_admin', status: 'active', created_at: timestamp, restaurants: row }))
  const profiles = [{ id: userId, full_name: 'Agustina Comercial', email: 'administracion@example.invalid', active: true }, { id: staffId, full_name: 'Lautaro Operaciones', email: 'equipo@example.invalid', active: true }]
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: profiles[0]!.email, app_metadata: {}, user_metadata: {}, created_at: timestamp,
    factors: account === 'super' ? [{ id: '79000000-0000-4000-8000-000000000001', factor_type: 'totp', friendly_name: 'Aplicación autenticadora', status: 'verified', created_at: timestamp, updated_at: timestamp }] : [] }
  if (account !== 'anonymous') {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const accessToken = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', aal: assurance, exp: expiresAt, amr: [{ method: 'password', timestamp: expiresAt - 3600 }] })).toString('base64url'), Buffer.from('isolated-brand-test-signature').toString('base64url')].join('.')
    await page.addInitScript(({ session, selected }) => { localStorage.setItem('sb-e2e-auth-token', JSON.stringify(session)); localStorage.setItem('mozzi:selected-restaurant', selected) }, {
      session: { access_token: accessToken, refresh_token: 'isolated-brand-test-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user }, selected: commerceId,
    })
  }
  await page.routeWebSocket('wss://e2e.invalid/**', socket => socket.close())
  const unexpected: string[] = []
  const mutations: string[] = []
  await page.route('https://e2e.invalid/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname
    let body: unknown
    if (request.method() === 'POST' && path === '/rest/v1/rpc/get_actor_authorization') {
      body = { userId, isSuperAdmin: account === 'super', aal: assurance, memberships: account === 'super' ? [] : memberships.slice(0, account === 'multi' ? 2 : 1).map(item => ({ restaurantId: item.restaurant_id, role: item.role, status: item.status })) }
    } else if (request.method() !== 'GET') {
      mutations.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'This visual fixture forbids mutations' }) }); return
    } else if (path === '/auth/v1/user') body = user
    else if (path === '/rest/v1/profiles') body = url.searchParams.get('id')?.startsWith('in.') ? profiles : profiles[0]
    else if (path === '/rest/v1/restaurants') body = url.searchParams.has('id') ? restaurant : restaurants
    else if (path === '/rest/v1/restaurant_members') {
      body = url.searchParams.has('user_id') ? (account === 'super' ? [] : memberships.slice(0, account === 'multi' ? 2 : 1)) : [memberships[0], { ...memberships[0], id: '73000000-0000-4000-8000-000000000003', user_id: staffId, role: 'order_manager' }]
    } else if (path === '/rest/v1/orders') body = [{ status: 'generated' }, { status: 'accepted' }, { status: 'completed' }]
    else if (path === '/rest/v1/categories') body = ['Fundas', 'Cargadores y cables'].map((name, index) => ({ id: `74000000-0000-4000-8000-00000000000${index + 1}`, restaurant_id: commerceId, name, slug: index ? 'cargadores-y-cables' : 'fundas', description: '', image_path: null, sort_order: index, active: true, deleted_at: null }))
    else if (path === '/rest/v1/business_hours') body = [1, 2, 3, 4, 5].map(day => ({ id: `75000000-0000-4000-8000-00000000000${day}`, restaurant_id: commerceId, day_of_week: day, slot_index: 0, opens_at: '09:00:00', closes_at: '18:00:00', spans_next_day: false, active: true }))
    else if (path === '/rest/v1/special_hours') body = []
    else if (path === '/rest/v1/delivery_zones') body = ['Centro', 'Barrios cercanos'].map((name, index) => ({ id: `76000000-0000-4000-8000-00000000000${index + 1}`, restaurant_id: commerceId, name, description: index ? 'Consultá disponibilidad para tu dirección.' : 'Dentro de las avenidas principales.', delivery_fee_cents: index ? 250000 : 150000, minimum_order_cents: 0, free_shipping_from_cents: 3000000, active: true, sort_order: index }))
    else {
      unexpected.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected read in isolated fixture' }) }); return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { unexpected, mutations }
}

const screens: { key: string; route: string; title: string; account: Account }[] = [
  { key: 'login', route: '/login', title: 'Ingresá al panel', account: 'anonymous' },
  { key: 'commerce-selection', route: '/admin/seleccionar-restaurante', title: 'Elegí un comercio', account: 'multi' },
  { key: 'central-control', route: '/superadmin', title: 'Control central', account: 'super' },
  { key: 'create-commerce', route: '/superadmin/restaurantes/nuevo', title: 'Crear comercio', account: 'super' },
  { key: 'restaurant-detail', route: `/superadmin/restaurantes/${commerceId}`, title: 'Casa Móvil', account: 'super' },
  { key: 'categories', route: '/admin/catalogo/categorias', title: 'Categorías', account: 'admin' },
  { key: 'import', route: '/admin/catalogo/importar', title: 'Importación masiva', account: 'admin' },
  { key: 'brand', route: '/admin/marca', title: 'Logo y portada', account: 'admin' },
  { key: 'hours', route: '/admin/horarios', title: 'Horarios', account: 'admin' },
  { key: 'team', route: '/admin/usuarios', title: 'Usuarios', account: 'admin' },
  { key: 'delivery', route: '/admin/zonas-de-envio', title: 'Zonas de envío', account: 'admin' },
  { key: 'security', route: '/admin/seguridad', title: 'Seguridad', account: 'admin' },
  { key: 'central-security', route: '/superadmin/seguridad', title: 'Seguridad de Super Admin', account: 'super' },
]

test.describe('administrative identity across secondary screens', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'Uses only synthetic sessions and e2e.invalid read mocks.')
  for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }]) {
    for (const screen of screens) {
      test(`${viewport.name} ${screen.key} uses the administrative identity without overflow or mutations`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport)
        const requests = await readOnlyFixture(page, screen.account)
        await page.goto(screen.route)
        await expect(page.getByRole('heading', { name: screen.title, exact: true, level: 1 })).toBeVisible()
        await expect(page.locator('.admin-app')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`${screen.key}-${viewport.name}.png`), fullPage: true })
        expect(requests.unexpected).toEqual([])
        expect(requests.mutations).toEqual([])
      })
    }
  }
  test('still requires MFA for a super administrator with an aal1 session', async ({ page }) => {
    const requests = await readOnlyFixture(page, 'super', 'aal1')
    await page.goto('/superadmin')
    await expect(page).toHaveURL(/\/auth\/mfa\?returnTo=/)
    await expect(page.getByRole('heading', { name: 'Segundo factor', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Control central', exact: true })).toHaveCount(0)
    expect(requests.mutations).toEqual([])
  })
})
