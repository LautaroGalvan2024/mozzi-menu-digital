import { expect, test, type Page } from '@playwright/test'

const restaurantId = '41000000-0000-4000-8000-000000000001'
const userId = '42000000-0000-4000-8000-000000000001'
const categoryId = '43000000-0000-4000-8000-000000000001'
const familyId = '44000000-0000-4000-8000-000000000001'
const blackId = '45000000-0000-4000-8000-000000000001'
const redId = '45000000-0000-4000-8000-000000000002'
const category = { id: categoryId, name: 'Fundas' }

async function adminFixture(page: Page, stockReady = true, role: 'restaurant_admin' | 'order_manager' = 'restaurant_admin') {
  const restaurant = {
    id: restaurantId, name: 'Casa Móvil', trade_name: 'Casa Móvil', slug: 'casa-movil', description: '', status: 'active',
    whatsapp_phone_e164: '+5493492123456', address: 'San Martín 123', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR',
    logo_path: null, cover_path: null, primary_color: '#4338ca', secondary_color: '#e0e7ff', delivery_enabled: true, pickup_enabled: true,
    minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: false, store_ordering_policy: 'always',
    store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false, inventory_mode: stockReady ? 'enforced' : 'never_enabled', inventory_cutover_id: null,
    updated_at: new Date().toISOString(),
  }
  const products = [blackId, redId].map((id, index) => ({
    id, category_id: categoryId, code: index ? 'FUN-ROJO' : 'FUN-NEGRO', name: index ? 'Funda roja' : 'Funda negra', description: 'Silicona para iPhone 15',
    base_price_cents: 950000, promotional_price_cents: null, promotion_starts_at: null, promotion_ends_at: null,
    image_path: null, active: true, available: true, featured: false, sort_order: index, family_id: familyId,
    variant_attributes: { Color: index ? 'Rojo' : 'Negro' }, categories: { name: 'Fundas' },
  }))
  const balances = products.map(product => ({ productId: product.id, initialized: true, onHand: '10', reserved: '3', available: '7', version: '7' }))
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'admin@example.invalid', app_metadata: {}, user_metadata: {}, factors: [], created_at: new Date().toISOString() }
  // Synthetic local session. Every API call is mocked; these tests never modify live inventory.
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
  const productSaves: Record<string, unknown>[] = []
  const familySaves: Record<string, unknown>[] = []
  const storeSaves: Record<string, unknown>[] = []
  await page.route('https://e2e.invalid/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    let body: unknown
    if (request.method() === 'GET' && path === '/auth/v1/user') body = user
    else if (request.method() === 'GET' && path === '/rest/v1/profiles') body = { id: userId, full_name: 'Administración Casa Móvil', email: user.email, active: true }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurant_members') body = [{ id: '46000000-0000-4000-8000-000000000001', restaurant_id: restaurantId, role, status: 'active', restaurants: restaurant }]
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_actor_authorization') body = { userId, isSuperAdmin: false, aal: 'aal1', memberships: [{ restaurantId, role, status: 'active' }] }
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_order_metrics') body = {
      generated: 8, whatsappOpened: 4, accepted: 5, completed: 3, cancelled: 1, expired: 0,
      corrected: 1, returned: 1, acceptedAmountCents: '1250000', completedAmountCents: '1000000',
      byFulfillment: { delivery: 5, pickup: 3 }, byPaymentMethod: [{ name: 'Efectivo', count: 3, amountCents: '1000000' }],
      validDeliveredCommercialCases: 3, physicalDispatches: 4, receivedReturnUnits: '2', sellableRestockedReturnUnits: '1',
    }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurants') body = restaurant
    else if (request.method() === 'GET' && path === '/rest/v1/orders') body = []
    else if (request.method() === 'GET' && path === '/rest/v1/categories') body = [category]
    else if (request.method() === 'GET' && path === '/rest/v1/products') body = url.searchParams.has('id') ? products.find(product => `eq.${product.id}` === url.searchParams.get('id')) : products
    else if (request.method() === 'GET' && ['/rest/v1/product_option_groups', '/rest/v1/product_quantity_prices'].includes(path)) body = []
    else if (request.method() === 'GET' && path === '/rest/v1/product_families') body = [{ id: familyId, code: 'FUNDAS', category_id: categoryId, name: 'Fundas de silicona', description: '', image_path: null, axes: ['Color'], active: true }]
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_catalog_stock') {
      const input = request.postDataJSON()
      expect(input.p_restaurant_id).toBe(restaurantId)
      body = { policy: { mode: restaurant.inventory_mode, version: '1', cutoverId: null, businessConfirmed: true, businessPolicy: null }, items: balances.filter(item => input.p_product_ids.includes(item.productId)) }
    } else if (request.method() === 'POST' && path === '/rest/v1/rpc/save_product_catalog_with_stock') {
      const input = request.postDataJSON()
      productSaves.push(input)
      if (input.p_stock) {
        const balance = balances.find(item => item.productId === input.p_product.id)!
        Object.assign(balance, { onHand: input.p_stock.onHand, available: String(Number(input.p_stock.onHand) - Number(balance.reserved)), version: '8' })
      }
      body = { id: input.p_product.id, code: 'FUN-NEGRO', stock: { items: balances.filter(item => item.productId === input.p_product.id) }, replayed: false }
    } else if (request.method() === 'POST' && path === '/rest/v1/rpc/save_product_family_with_stock') {
      const input = request.postDataJSON()
      familySaves.push(input)
      body = { familyId, stock: { items: balances }, replayed: false }
    } else if (request.method() === 'POST' && path === '/functions/v1/mercadopago-connect' && request.postDataJSON().action === 'status') {
      expect(request.postDataJSON().restaurantId).toBe(restaurantId)
      body = { configured: true, environment: 'production', readyForPayments: true, connectionEnvironment: 'production', connectionIssue: null, connection: { connected: true } }
    } else if (request.method() === 'PATCH' && path === '/rest/v1/restaurants') {
      expect(url.searchParams.get('id')).toBe(`eq.${restaurantId}`)
      const input = request.postDataJSON()
      storeSaves.push(input)
      Object.assign(restaurant, input)
      body = { id: restaurantId }
    } else {
      unexpected.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected mocked request' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { unexpected, productSaves, familySaves, storeSaves }
}

test.describe('catalog stock and store setup', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'This suite uses only the isolated e2e.invalid mock environment.')

  test('mobile navigation contains keyboard focus, closes with Escape and exposes secondary settings', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const requests = await adminFixture(page)
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Resumen', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Administración' })).not.toBeVisible()
    const trigger = page.getByRole('button', { name: 'Abrir navegación' })
    await trigger.click()
    const drawer = page.getByRole('dialog', { name: 'Navegación del panel' })
    await expect(drawer).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cerrar navegación' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(drawer.getByRole('button', { name: 'Salir', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(drawer.getByRole('button', { name: 'Cerrar navegación' })).toBeFocused()
    await expect(page.locator('.admin-workspace')).toHaveAttribute('inert', '')
    await drawer.locator('summary').filter({ hasText: 'Configuración' }).click()
    await expect(drawer.getByRole('link', { name: 'Medios de pago', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('navigation-mobile.png') })
    await page.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await page.getByRole('link', { name: 'Productos', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(requests.unexpected).toEqual([])
  })

  test('order managers only see permitted navigation and cannot open store administration', async ({ page }) => {
    const requests = await adminFixture(page, true, 'order_manager')
    await page.goto('/admin')
    const nav = page.getByRole('navigation', { name: 'Administración' })
    await expect(nav.getByRole('link', { name: 'Pedidos', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Stock', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Productos', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Tienda online', exact: true })).toHaveCount(0)
    await expect(nav.locator('summary')).toHaveCount(0)
    await page.goto('/admin/tienda')
    await expect(page).toHaveURL(/\/admin\/pedidos$/)
    await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()
    expect(requests.storeSaves).toEqual([])
  })

  for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 1000 }]) {
    test(`${viewport.name} keeps the overview focused while detailed reports remain accessible`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const requests = await adminFixture(page)
      await page.goto('/admin')
      await expect(page.getByRole('heading', { name: 'Resumen', level: 1 })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Resumen del día' }).getByRole('heading', { level: 2 })).toHaveCount(4)
      await expect(page.getByText('Casos comerciales entregados vigentes')).not.toBeVisible()
      await expect(page.getByRole('img', { name: /Código QR/ })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`overview-${viewport.name}.png`), fullPage: true })
      await page.getByText('Ver detalle del día', { exact: true }).click()
      await expect(page.getByText('Casos comerciales entregados vigentes')).toBeVisible()
      expect(requests.unexpected).toEqual([])
    })

    test(`${viewport.name} separates commerce settings from store publication and keeps advanced fields optional`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const requests = await adminFixture(page)
      await page.goto('/admin/configuracion')
      await expect(page.getByRole('heading', { name: 'Configuración general', level: 1 })).toBeVisible()
      await expect(page.getByLabel('Nombre comercial', { exact: true })).toBeVisible()
      await expect(page.getByLabel('Nombre interno', { exact: true })).not.toBeVisible()
      await expect(page.getByRole('link', { name: 'Configurar tienda online' })).toHaveAttribute('href', '/admin/tienda')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`commerce-settings-${viewport.name}.png`), fullPage: true })
      await page.getByText('Configuración regional e interna', { exact: true }).click()
      await expect(page.getByLabel('Nombre interno', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Guardar cambios' }).click()
      await expect(page.getByRole('status')).toContainText('Configuración guardada.')
      expect(requests.storeSaves).toHaveLength(1)
      expect(requests.storeSaves[0]).not.toHaveProperty('store_enabled')
      expect(requests.storeSaves[0]).not.toHaveProperty('store_checkout_online_enabled')
      expect(requests.unexpected).toEqual([])
    })

    test(`${viewport.name} edits an absolute product quantity together with its catalog fields`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const requests = await adminFixture(page)
      await page.goto(`/admin/catalogo/productos/${blackId}`)
      await expect(page.getByLabel('Stock (unidades)')).toHaveValue('10')
      await expect(page.getByText('Stock actual: 10 · Reservado: 3 · Disponible: 7')).toBeVisible()
      await page.getByLabel('Stock (unidades)').fill('8')
      await page.getByLabel('Nombre', { exact: true }).fill('Funda negra nueva')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const mainFields = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Datos principales' }) })
      await mainFields.screenshot({ path: testInfo.outputPath(`product-stock-${viewport.name}.png`) })
      await page.getByRole('button', { name: 'Guardar producto' }).click()
      await expect(page.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible()
      expect(requests.productSaves).toHaveLength(1)
      expect(requests.productSaves[0]).toMatchObject({ p_restaurant_id: restaurantId, p_product: { id: blackId, name: 'Funda negra nueva' }, p_stock: { onHand: '8', expectedVersion: '7' } })
      expect(requests.productSaves[0]!.p_operation_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(requests.unexpected).toEqual([])
    })

    test(`${viewport.name} adjusts one variant and preserves the other variant quantity`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const requests = await adminFixture(page)
      await page.goto('/admin/catalogo/productos')
      await expect(page.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`catalog-list-${viewport.name}.png`), fullPage: true })
      await page.getByRole('button', { name: /Productos con variantes/ }).click()
      await page.getByRole('button', { name: 'Fundas de silicona', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Ficha con variantes' })
      const quantities = dialog.getByLabel('Cantidad en stock')
      await expect(quantities).toHaveCount(2)
      await expect(quantities.nth(0)).toHaveValue('10')
      await quantities.nth(0).fill('8')
      await quantities.nth(1).fill('')
      await quantities.nth(0).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await dialog.screenshot({ path: testInfo.outputPath(`variant-stock-${viewport.name}.png`) })
      await dialog.getByRole('button', { name: 'Guardar ficha y variantes' }).click()
      await expect(page.getByText('Ficha y cantidades de stock guardadas.', { exact: true })).toBeVisible()
      expect(requests.familySaves).toHaveLength(1)
      expect(requests.familySaves[0]).toMatchObject({ p_restaurant_id: restaurantId, p_family: { id: familyId }, p_stock_rows: [{ productId: blackId, onHand: '8', expectedVersion: '7' }] })
      expect(requests.familySaves[0]!.p_operation_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(requests.unexpected).toEqual([])
    })

    test(`${viewport.name} publishes the store and online checkout from its own settings route`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const requests = await adminFixture(page)
      await page.goto('/admin/tienda')
      await expect(page.getByRole('heading', { name: 'Tienda online', exact: true, level: 1 })).toBeVisible()
      await page.getByRole('checkbox', { name: /Publicar mi tienda online/ }).check()
      await page.getByRole('checkbox', { name: 'Pagos online con Mercado Pago' }).check()
      await page.getByLabel('Cuándo recibir pedidos').selectOption('business_hours')
      await page.getByRole('button', { name: 'Guardar y publicar tienda' }).click()
      await expect(page.getByRole('status')).toContainText('Tu tienda está publicada')
      const storeLink = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Tienda online', level: 3 }) })
      await expect(storeLink.getByText('Publicado', { exact: true })).toBeVisible()
      await expect(storeLink.getByRole('link', { name: 'Abrir', exact: true })).toHaveAttribute('href', 'http://127.0.0.1:4173/t/casa-movil')
      await expect(storeLink.getByRole('img', { name: 'Código QR de Tienda online' })).toHaveCount(0)
      await storeLink.getByRole('button', { name: 'Ver QR' }).click()
      await expect(storeLink.getByRole('img', { name: 'Código QR de Tienda online' })).toBeVisible()
      await storeLink.getByRole('button', { name: 'Ocultar QR' }).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`store-settings-${viewport.name}.png`), fullPage: true })
      expect(requests.storeSaves).toEqual([{ store_enabled: true, store_ordering_policy: 'business_hours', store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: true }])
      expect(requests.unexpected).toEqual([])
    })
  }

  test('WhatsApp publication stays available while stock is not yet active', async ({ page }) => {
    const requests = await adminFixture(page, false)
    await page.goto('/admin/tienda')
    await expect(page.getByRole('checkbox', { name: 'Pagos online con Mercado Pago' })).toBeDisabled()
    await expect(page.getByRole('link', { name: 'activá el control de stock' })).toHaveAttribute('href', '/admin/stock')
    await page.getByRole('checkbox', { name: /Publicar mi tienda online/ }).check()
    await page.getByRole('button', { name: 'Guardar y publicar tienda' }).click()
    await expect(page.getByRole('status')).toContainText('Tu tienda está publicada')
    expect(requests.storeSaves[0]).toMatchObject({ store_enabled: true, store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false })
    expect(requests.unexpected).toEqual([])
  })
})
