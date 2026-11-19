import { expect, test, type Page } from '@playwright/test'
import { disabledStageOneFeatures } from './stage-one-fixture'

const commerceId = '71000000-0000-4000-8000-000000000001'
const otherCommerceId = '71000000-0000-4000-8000-000000000002'
const userId = '72000000-0000-4000-8000-000000000001'
const staffId = '72000000-0000-4000-8000-000000000002'
type Account = 'anonymous' | 'admin' | 'multi' | 'super'

async function readOnlyFixture(page: Page, account: Account, assurance: 'aal1' | 'aal2' = account === 'super' ? 'aal2' : 'aal1', pilot = true) {
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
    } else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_stage_one_features') {
      expect(request.postDataJSON()).toEqual({ p_restaurant_id: commerceId })
      body = { ...disabledStageOneFeatures, campaigns: pilot, sellers: pilot, delivery_schedule: pilot }
    } else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_order_metrics') {
      body = { generated: 0, whatsappOpened: 0, accepted: 0, completed: 0, cancelled: 0, expired: 0, corrected: 0, returned: 0,
        acceptedAmountCents: '0', completedAmountCents: '0', byFulfillment: {}, byPaymentMethod: [],
        validDeliveredCommercialCases: 0, physicalDispatches: 0, receivedReturnUnits: '0', sellableRestockedReturnUnits: '0' }
    } else if (request.method() === 'POST' && ['/rest/v1/rpc/get_delivery_schedule_policies', '/rest/v1/rpc/get_admin_campaigns'].includes(path)) {
      body = []
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
    else if (path === '/rest/v1/sellers') body = []
    else if (path === '/rest/v1/delivery_zones') body = ['Centro', 'Barrios cercanos'].map((name, index) => ({ id: `76000000-0000-4000-8000-00000000000${index + 1}`, restaurant_id: commerceId, name, description: index ? 'Consultá disponibilidad para tu dirección.' : 'Dentro de las avenidas principales.', delivery_fee_cents: index ? 250000 : 150000, minimum_order_cents: 0, free_shipping_from_cents: 3000000, active: true, sort_order: index }))
    else {
      unexpected.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected read in isolated fixture' }) }); return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { unexpected, mutations, restaurant }
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
  { key: 'sellers', route: '/admin/vendedores', title: 'Vendedores', account: 'admin' },
  { key: 'campaigns', route: '/admin/promociones', title: 'Revistas y anuncios', account: 'admin' },
  { key: 'security', route: '/admin/seguridad', title: 'Seguridad', account: 'admin' },
  { key: 'central-security', route: '/superadmin/seguridad', title: 'Seguridad de Super Admin', account: 'super' },
]

test.describe('administrative identity across secondary screens', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'Uses only synthetic sessions and e2e.invalid read mocks.')
  test('existing commerce keeps administration but can’t open pilot routes by URL', async ({ page }) => {
    const { unexpected, mutations } = await readOnlyFixture(page, 'admin', 'aal1', false)
    for (const pathname of ['/admin/vendedores', '/admin/promociones']) {
      await page.goto(pathname)
      await expect(page).toHaveURL('/admin')
      await expect(page.getByRole('navigation', { name: 'Administración' }).getByRole('link', { name: 'Vendedores' })).toHaveCount(0)
      await expect(page.getByRole('navigation', { name: 'Administración' }).getByRole('link', { name: 'Promociones y difusión' })).toHaveCount(0)
    }
    await page.goto('/admin/zonas-de-envio')
    await expect(page.getByRole('button', { name: 'Nueva zona' })).toBeVisible()
    expect(unexpected).toEqual([])
    expect(mutations).toEqual([])
  })
  test('creates a seller link on mobile with the published channels preselected', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await readOnlyFixture(page, 'admin')
    const sellers: Record<string, unknown>[] = []
    await page.route('https://e2e.invalid/rest/v1/sellers?**', route => route.fulfill({ json: sellers }))
    await page.route('https://e2e.invalid/rest/v1/rpc/save_seller', route => {
      const input = route.request().postDataJSON()
      expect(input).toMatchObject({ p_restaurant_id: commerceId, p_name: 'Lucía', p_whatsapp_phone: '+5491199999999', p_menu_enabled: true, p_store_enabled: true, p_image_path: null })
      sellers.push({ id: input.p_id, name: input.p_name, whatsapp_phone: input.p_whatsapp_phone, image_path: null, active: true, menu_enabled: true, store_enabled: true })
      return route.fulfill({ json: input.p_id })
    })
    await page.goto('/admin/vendedores')
    await page.getByRole('button', { name: 'Nuevo vendedor' }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('Lucía')
    await page.getByLabel('WhatsApp').fill('+54 9 11 9999 9999')
    await page.getByLabel('WhatsApp').press('Enter')
    const copy = page.getByRole('button', { name: 'Copiar enlace de Tienda de Lucía' })
    await copy.click()
    await expect(page.getByRole('status')).toHaveText('Copiaste el enlace de Lucía.')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:4173/t/casa-movil?vendedor=${sellers[0]!.id}`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
  test('an administrator can retry a pending invitation without changing the membership', async ({ page }) => {
    await readOnlyFixture(page, 'admin')
    const membership = { id: '73000000-0000-4000-8000-000000000003', user_id: staffId, role: 'order_manager', status: 'invited', created_at: '2026-10-27T12:00:00Z' }
    await page.route('https://e2e.invalid/rest/v1/restaurant_members?**', async route => {
      if (new URL(route.request().url()).searchParams.has('user_id')) return route.fallback()
      await route.fulfill({ json: [membership] })
    })
    const attempts: unknown[] = []
    await page.route('https://e2e.invalid/functions/v1/invite-restaurant-user', async route => {
      attempts.push(route.request().postDataJSON())
      await route.fulfill({ json: { invitationSent: attempts.length === 2, deliveryPending: attempts.length === 1 } })
    })
    await page.goto('/admin/usuarios')
    const resend = page.getByRole('button', { name: 'Reenviar invitación' })
    await resend.click()
    await expect(page.getByRole('status').filter({ hasText: 'El acceso quedó guardado' })).toBeVisible()
    await resend.click()
    await expect(page.getByRole('status').filter({ hasText: 'Invitación enviada por correo' })).toBeVisible()
    const body = { restaurantId: commerceId, resendUserId: staffId, role: 'order_manager' }
    expect(attempts).toEqual([body, body])
  })

  test('team suspension keeps focus and only changes access after confirmation', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await readOnlyFixture(page, 'admin')
    const attempts: unknown[] = []
    await page.route('https://e2e.invalid/rest/v1/rpc/set_restaurant_member_status', async route => {
      attempts.push(route.request().postDataJSON())
      await route.fulfill({ json: true })
    })
    await page.goto('/admin/usuarios')
    const action = page.getByRole('button', { name: 'Suspender', exact: true })
    await action.click()
    const dialog = page.getByRole('dialog', { name: '¿Suspender este acceso?' })
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(action).toBeFocused()
    expect(attempts).toHaveLength(0)
    await action.click()
    await dialog.getByRole('button', { name: 'Suspender acceso' }).click()
    await expect.poll(() => attempts.length).toBe(1)
    expect(attempts[0]).toEqual({
      p_membership_id: '73000000-0000-4000-8000-000000000003',
      p_status: 'suspended',
    })
  })

  test('uploads a portrait cover within database bounds and removes every generated variant', async ({ page }) => {
    const fixture = await readOnlyFixture(page, 'admin')
    const uploads = new Map<string, Buffer>()
    const dimensions: { width: number; height: number; path: string }[] = []
    const removed: string[] = []
    await page.route('https://e2e.invalid/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && path.startsWith('/storage/v1/object/restaurant-assets/')) {
        const form = await new Request(request.url(), { method: 'POST', headers: request.headers(), body: request.postDataBuffer()! }).formData()
        const image = [...form.values()].find((value): value is File => typeof value !== 'string')!
        const objectPath = path.replace('/storage/v1/object/restaurant-assets/', '')
        uploads.set(objectPath, Buffer.from(await image.arrayBuffer()))
        await route.fulfill({ json: { Key: `restaurant-assets/${objectPath}` } })
      } else if (request.method() === 'POST' && path === '/rest/v1/image_assets') {
        const rows = request.postDataJSON() as { width: number; height: number; path: string; size_bytes: number }[]
        dimensions.push(...rows)
        const valid = rows.every(row => row.width >= 1 && row.width <= 1200 && row.height >= 1 && row.height <= 1200 && row.size_bytes <= 1048576)
        await route.fulfill({ status: valid ? 201 : 400, json: valid ? rows : { code: '23514', message: 'image_assets_height_check' } })
      } else if (request.method() === 'PATCH' && path === '/rest/v1/restaurants') {
        Object.assign(fixture.restaurant, request.postDataJSON())
        await route.fulfill({ json: { id: commerceId } })
      } else if (request.method() === 'GET' && path.startsWith('/storage/v1/object/public/restaurant-assets/')) {
        const bytes = uploads.get(path.replace('/storage/v1/object/public/restaurant-assets/', ''))
        await route.fulfill({ status: bytes ? 200 : 404, contentType: 'image/webp', body: bytes ?? '' })
      } else if (request.method() === 'POST' && path === '/rest/v1/rpc/prepare_image_asset_cleanup') {
        expect(request.postDataJSON().p_restaurant_id).toBe(commerceId)
        expect(uploads.has(request.postDataJSON().p_path)).toBe(true)
        expect(fixture.restaurant.cover_path).toBeNull()
        await route.fulfill({ json: { paths: [...uploads.keys()], retained: false } })
      } else if (request.method() === 'DELETE' && path === '/storage/v1/object/restaurant-assets') {
        removed.push(...request.postDataJSON().prefixes)
        await route.fulfill({ json: removed.map(name => ({ name })) })
      } else if (request.method() === 'PATCH' && path === '/rest/v1/image_assets') {
        await route.fulfill({ status: 204 })
      } else await route.fallback()
    })
    await page.goto('/admin/marca')
    await expect(page.getByRole('heading', { name: 'Logo y portada', exact: true })).toBeVisible()
    // Same portrait dimensions as the reported PNG, with synthetic pixels.
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 485; canvas.height = 497
      canvas.getContext('2d')!.fillRect(0, 0, 485, 497)
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    await page.locator('#cover-upload').setInputFiles({ name: 'Captura.PNG', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    const cover = page.getByRole('img', { name: 'Portada actual' })
    await expect(cover).toBeVisible()
    expect(dimensions.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 320, height: 328 }, { width: 485, height: 497 },
    ])
    await expect(cover).toHaveAttribute('srcset', /320w, .*485w$/)
    await expect(page.getByRole('alert')).toHaveCount(0)
    page.on('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Eliminar' }).click()
    await expect(cover).toHaveCount(0)
    await expect.poll(() => removed).toEqual([...uploads.keys()])
    expect(fixture.unexpected).toEqual([])
    expect(fixture.mutations).toEqual([])
  })

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
