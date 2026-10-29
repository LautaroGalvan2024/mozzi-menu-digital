import { expect, test, type Page } from '@playwright/test'

const restaurantId = '21000000-0000-4000-8000-000000000001'
const userId = '22000000-0000-4000-8000-000000000001'
const restaurant = {
  id: restaurantId, name: 'Casa Móvil', trade_name: 'Casa Móvil', slug: 'casa-movil', description: '', status: 'active',
  whatsapp_phone_e164: '+5493492123456', address: 'San Martín 123', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR',
  logo_path: null, cover_path: null, primary_color: '#4338ca', secondary_color: '#e0e7ff', delivery_enabled: true, pickup_enabled: true,
  minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: true, updated_at: new Date().toISOString(),
}
const paidOrder = {
  id: '23000000-0000-4000-8000-000000000001', restaurant_id: restaurantId, action_id: '24000000-0000-4000-8000-000000000001',
  display_number: 'CM-0001', status: 'generated', channel: 'store', checkout_mode: 'online', payment_status: 'approved', inventory_tracked: true, inventory_outcome: 'none',
  customer_name: 'Lucía Fernández', customer_phone: '+54 9 3492 123456', fulfillment_type: 'pickup',
  delivery_address: null, delivery_city: null, delivery_neighborhood: null, delivery_floor: null, delivery_apartment: null, delivery_reference: null, customer_notes: null,
  payment_method_id: '25000000-0000-4000-8000-000000000001', payment_method_name_snapshot: 'Mercado Pago', payment_transfer_alias_snapshot: null,
  payment_account_holder_snapshot: null, payment_bank_name_snapshot: null, payment_instructions_snapshot: null,
  subtotal_cents: 1050000, discount_cents: 0, surcharge_cents: 0, delivery_fee_cents: 0, total_cents: 1050000, currency_code: 'ARS',
  whatsapp_opened_at: null, accepted_by: null, accepted_at: null, completed_at: null, cancelled_at: null, cancel_reason: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}
const orders = [paidOrder,
  { ...paidOrder, id: '23000000-0000-4000-8000-000000000002', display_number: 'CM-0002', payment_status: 'pending', customer_name: 'Tomás Rodríguez' },
  { ...paidOrder, id: '23000000-0000-4000-8000-000000000003', display_number: 'CM-0003', customer_name: 'Cliente sin teléfono válido', customer_phone: 'sin teléfono' },
]

async function adminFixture(page: Page, options: { inventoryCounting?: boolean } = {}) {
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'admin@example.invalid', app_metadata: {}, user_metadata: {}, factors: [], created_at: new Date().toISOString() }
  // Synthetic local session. All provider requests below are intercepted; no credentials or remote service are used.
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
  await page.route('https://e2e.invalid/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let body: unknown
    if (request.method() === 'GET' && path === '/auth/v1/user') body = user
    else if (request.method() === 'GET' && path === '/rest/v1/profiles') body = { id: userId, full_name: 'Administración Casa Móvil', email: user.email, active: true }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurant_members') body = [{ id: '26000000-0000-4000-8000-000000000001', restaurant_id: restaurantId, role: 'restaurant_admin', status: 'active', restaurants: restaurant }]
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_actor_authorization') body = { userId, isSuperAdmin: false, aal: 'aal1', memberships: [{ restaurantId, role: 'restaurant_admin', status: 'active' }] }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurants') body = restaurant
    else if (request.method() === 'GET' && path === '/rest/v1/orders') body = new URL(request.url()).searchParams.has('id') ? paidOrder : orders
    else if (request.method() === 'GET' && path === '/rest/v1/order_items') body = [{
      id: '27000000-0000-4000-8000-000000000001', order_id: paidOrder.id, product_name_snapshot: 'Funda de silicona', product_code_snapshot: 'FUN-NEGRO', quantity: 1,
      unit_price_cents: 1050000, base_subtotal_cents: 1050000, pricing_mode_snapshot: 'unit', options_total_unit_cents: 0, line_total_cents: 1050000, notes: null,
      pricing_breakdown_snapshot: { mode: 'unit', unitPriceCents: 1050000, baseSubtotalCents: 1050000, components: [] }, variant_attributes_snapshot: { Modelo: 'iPhone 15', Color: 'Negro' },
    }]
    else if (request.method() === 'GET' && ['/rest/v1/order_events', '/rest/v1/order_item_options'].includes(path)) body = []
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_order_by_action') body = { replacementOrderId: null, inventoryOperations: [] }
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_inventory_overview') body = {
      policy: { mode: options.inventoryCounting ? 'paused' : 'enforced', version: '1', activatedAt: '2026-10-27T12:00:00Z', pausedAt: null, cutoverId: options.inventoryCounting ? '29000000-0000-4000-8000-000000000001' : null, countStartedAt: options.inventoryCounting ? '2026-10-27T12:00:00Z' : null, businessConfirmed: true, businessPolicy: { otherChannels: 'record_before_handoff' } },
      operations: [],
    }
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_inventory_items') body = {
      items: ['Funda negra', 'Funda roja', 'Cable USB'].map((name, index) => ({ productId: '28000000-0000-4000-8000-00000000000' + (index + 1), name, code: 'PROD-00' + index, archived: false, initialized: true, onHand: '10', reserved: '2', available: '8', version: '1' })), nextCursor: null,
    }
    else {
      unexpected.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected mocked request' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Content-Range': '0-2/3', 'Access-Control-Expose-Headers': 'Content-Range' }, body: JSON.stringify(body) })
  })
  return unexpected
}

test.describe('admin WhatsApp contact', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'This suite uses only the isolated e2e.invalid mock environment.')

  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    test(`${viewport.name} shows safe contact actions and an unambiguous paid state`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      const unexpected = await adminFixture(page)
      await page.goto('/admin/pedidos')
      await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()
      await expect(page.getByText('3 resultados', { exact: true })).toBeVisible()
      const container = viewport.name === 'desktop' ? page.getByRole('table') : page.locator('article').first()
      await expect(container).toBeVisible()
      const approved = container.getByRole('link', { name: 'Escribir a Lucía Fernández por WhatsApp sobre CM-0001' })
      await expect(approved).toBeVisible()
      await expect(approved).toHaveAttribute('target', '_blank')
      await expect(approved).toHaveAttribute('rel', 'noopener noreferrer')
      await expect(approved).toHaveAttribute('title', 'Escribir a Lucía Fernández por WhatsApp sobre CM-0001')
      const destination = new URL((await approved.getAttribute('href'))!)
      expect(destination.origin).toBe('https://wa.me')
      expect(destination.pathname).toBe('/5493492123456')
      expect(destination.searchParams.get('text')).toBe('Hola, Lucía Fernández. Somos Casa Móvil. Recibimos tu pedido CM-0001 y lo estamos preparando. ¡Gracias por tu compra!')
      const box = await approved.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeGreaterThanOrEqual(44)
      const approvedRow = viewport.name === 'desktop' ? page.getByRole('row').filter({ hasText: 'CM-0001' }) : container
      await expect(approvedRow.getByText('Pagado · Pendiente de preparación')).toBeVisible()
      await expect(approvedRow.getByText('Generado', { exact: true })).toHaveCount(0)
      const pendingRow = viewport.name === 'desktop' ? page.getByRole('row').filter({ hasText: 'CM-0002' }) : page.locator('article').nth(1)
      const pending = pendingRow.getByRole('link', { name: /por WhatsApp/ })
      const pendingMessage = new URL((await pending.getAttribute('href'))!).searchParams.get('text')!
      expect(pendingMessage).toContain('Te escribimos por tu pedido CM-0002.')
      expect(pendingMessage).not.toContain('preparando')
      const invalidRow = viewport.name === 'desktop' ? page.getByRole('row').filter({ hasText: 'CM-0003' }) : page.locator('article').nth(2)
      await expect(invalidRow.getByRole('link', { name: /por WhatsApp/ })).toHaveCount(0)
      await expect(invalidRow.getByRole('link', { name: 'Ver CM-0003' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (viewport.name === 'mobile') {
        await page.getByText('Fechas y modalidad', { exact: true }).click()
        const from = await page.getByLabel('Desde', { exact: true }).boundingBox()
        const to = await page.getByLabel('Hasta', { exact: true }).boundingBox()
        expect(from!.y).toBe(to!.y)
        await page.getByText('Fechas y modalidad', { exact: true }).click()
        const number = await approvedRow.getByText('CM-0001', { exact: true }).boundingBox()
        const state = await approvedRow.getByText('Pagado · Pendiente de preparación').boundingBox()
        expect(state!.y).toBeGreaterThanOrEqual(number!.y + number!.height)
      }
      // The final send remains with the operator. Do not follow or open any WhatsApp link during this test.
      await page.screenshot({ path: testInfo.outputPath(`orders-whatsapp-${viewport.name}.png`), fullPage: true })
      expect(unexpected).toEqual([])
    })

    test(`${viewport.name} keeps stock editing prominent and occasional inventory tools collapsed`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const unexpected = await adminFixture(page)
      await page.goto('/admin/stock')
      await expect(page.getByRole('heading', { name: 'Stock', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Editar stock de Funda negra' })).toHaveAttribute('href', '/admin/catalogo/productos/28000000-0000-4000-8000-000000000001')
      const balances = page.getByRole('table', { name: 'Existencias de productos' })
      const firstProduct = balances.getByRole('row').filter({ hasText: 'Funda negra' })
      const editStock = await firstProduct.getByRole('link', { name: 'Editar stock de Funda negra' }).boundingBox()
      expect(editStock!.x).toBeGreaterThanOrEqual(0)
      expect(editStock!.x + editStock!.width).toBeLessThanOrEqual(viewport.width)
      if (viewport.name === 'mobile') {
        for (const label of ['Total', 'Reservado', 'Disponible']) await expect(firstProduct.getByText(label, { exact: true })).toBeVisible()
        const quantities = await firstProduct.locator('.inventory-quantity').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().top))
        expect(new Set(quantities).size).toBe(1)
        expect(editStock!.height).toBeGreaterThanOrEqual(44)
      }
      await expect(page.getByRole('combobox', { name: 'Acción', exact: true })).not.toBeVisible()
      await page.getByText('Ingresos, ajustes y ventas externas', { exact: true }).click()
      await expect(page.getByRole('combobox', { name: 'Acción', exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.getByText('Ingresos, ajustes y ventas externas', { exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: testInfo.outputPath(`stock-overview-${viewport.name}.png`), fullPage: true })
      expect(unexpected).toEqual([])
    })

    test(`${viewport.name} prioritizes the paid order and customer over its technical history`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const unexpected = await adminFixture(page)
      await page.goto('/admin/pedidos/' + paidOrder.id)
      await expect(page.getByRole('heading', { name: 'CM-0001', exact: true })).toBeVisible()
      await expect(page.getByText('Pagado · Pendiente de preparación', { exact: true })).toHaveCount(1)
      await expect(page.getByRole('link', { name: 'Aceptar para preparar' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Cliente y entrega' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`order-detail-${viewport.name}.png`), fullPage: true })
      expect(unexpected).toEqual([])
    })
  }

  test('mobile keeps stock count inputs visible within each product row', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const unexpected = await adminFixture(page, { inventoryCounting: true })
    await page.goto('/admin/stock')
    const balances = page.getByRole('table', { name: 'Existencias de productos' })
    await expect(balances).toBeVisible()
    const count = balances.getByRole('textbox', { name: 'Conteo de Funda negra', exact: true })
    await expect(count).toBeVisible()
    const box = await count.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    expect(box!.height).toBeGreaterThanOrEqual(44)
    await count.fill('10')
    await expect(count).toHaveValue('10')
    await expect(balances.getByRole('link', { name: /Editar stock/ })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: testInfo.outputPath('stock-count-mobile.png'), fullPage: true })
    expect(unexpected).toEqual([])
  })
})
