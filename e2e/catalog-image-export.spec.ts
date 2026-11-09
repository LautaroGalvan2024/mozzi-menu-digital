import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

const restaurantId = '81000000-0000-4000-8000-000000000001'
const userId = '82000000-0000-4000-8000-000000000001'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR/8AAAAASUVORK5CYII=', 'base64')

async function fixture(page: Page) {
  const restaurant = {
    id: restaurantId, name: 'Catálogo completo', trade_name: 'Catálogo completo', slug: 'catalogo-completo', description: '', status: 'active',
    whatsapp_phone_e164: '+5493492123456', address: '', city: '', timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR',
    logo_path: null, cover_path: null, primary_color: '#4338ca', secondary_color: '#e0e7ff', delivery_enabled: true, pickup_enabled: true,
    minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: false, store_ordering_policy: 'always',
    store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false, inventory_mode: 'never_enabled', inventory_cutover_id: null, updated_at: new Date().toISOString(),
  }
  const rows = Array.from({ length: 61 }, (_, index) => {
    const id = `83000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    return { id, code: `SKU-${index}`, name: `Producto ${index}`, description: '', base_price_cents: 1000, promotional_price_cents: null, image_path: `restaurants/${restaurantId}/products/${id}/image.png`, active: index % 2 === 0, available: index % 3 === 0, featured: false, sort_order: index, category_id: '84000000-0000-4000-8000-000000000001', categories: { name: 'General' } }
  })
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'export@example.invalid', app_metadata: {}, user_metadata: {}, factors: [], created_at: new Date().toISOString() }
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  const accessToken = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp: expiresAt })).toString('base64url'), Buffer.from('synthetic-signature').toString('base64url')].join('.')
  await page.addInitScript(({ session, selected }) => {
    localStorage.setItem('sb-e2e-auth-token', JSON.stringify(session))
    localStorage.setItem('mozzi:selected-restaurant', selected)
  }, { session: { access_token: accessToken, refresh_token: 'synthetic-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user }, selected: restaurantId })
  await page.routeWebSocket('wss://e2e.invalid/**', socket => socket.close())
  const unexpected: string[] = []
  const exportPages: string[] = []
  await page.route('https://e2e.invalid/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let body: unknown
    let total: number | undefined
    if (path.startsWith('/storage/v1/object/public/restaurant-assets/')) { await route.fulfill({ status: 200, contentType: 'image/png', body: png }); return }
    if (path === '/auth/v1/user') body = user
    else if (path === '/rest/v1/profiles') body = { id: userId, full_name: 'Administración', email: user.email, active: true }
    else if (path === '/rest/v1/restaurant_members') body = [{ id: '85000000-0000-4000-8000-000000000001', restaurant_id: restaurantId, role: 'restaurant_admin', status: 'active', restaurants: restaurant }]
    else if (path === '/rest/v1/rpc/get_actor_authorization') body = { userId, isSuperAdmin: false, aal: 'aal1', memberships: [{ restaurantId, role: 'restaurant_admin', status: 'active' }] }
    else if (path === '/rest/v1/restaurants') body = restaurant
    else if (['/rest/v1/orders', '/rest/v1/categories', '/rest/v1/product_families'].includes(path)) body = []
    else if (path === '/rest/v1/products') {
      expect(url.searchParams.get('restaurant_id')).toBe(`eq.${restaurantId}`)
      expect(url.searchParams.get('deleted_at')).toBe('is.null')
      if (url.searchParams.get('limit') === '500') {
        expect(url.searchParams.has('or')).toBe(false)
        const after = url.searchParams.get('id')?.slice(3) ?? ''
        exportPages.push(after)
        body = rows.filter(row => row.id > after).slice(0, 25)
      } else {
        body = url.searchParams.has('or') ? rows.slice(0, 1) : rows.slice(0, 50)
        total = url.searchParams.has('or') ? 1 : rows.length
      }
    } else { unexpected.push(`${route.request().method()} ${path}`); body = [] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: total === undefined ? {} : { 'content-range': `0-${Math.min(total, 50) - 1}/${total}`, 'access-control-expose-headers': 'content-range' } })
  })
  return { unexpected, exportPages }
}

test.describe('catalog image ZIP export', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'Only isolated mock services are allowed.')

  test('mobile exports all pages despite a visible search using disk-backed fallback', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }) })
    const requests = await fixture(page)
    await page.goto('/admin/catalogo/productos')
    await expect(page.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Buscar productos' }).fill('Producto 0')
    await expect(page.getByText('1 producto', { exact: true })).toBeVisible()
    await page.getByText('Más acciones', { exact: true }).click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Descargar imágenes' }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/^imagenes-catalogo-.*\.zip$/)
    const zip = await JSZip.loadAsync(await readFile((await download.path())!), { checkCRC32: true })
    const manifest = JSON.parse(await zip.file('images-manifest.json')!.async('text'))
    expect(manifest.products).toHaveLength(61)
    expect(manifest.products[60].sku).toBe('SKU-60')
    expect(manifest.errors).toEqual([])
    await expect(page.getByText('61 imágenes guardadas. 0 productos sin imagen.')).toBeVisible()
    expect(requests.exportPages).toHaveLength(4)
    expect(requests.unexpected).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('image-export-mobile.png'), fullPage: true })
  })

  test('desktop writes a complete ZIP to the selected file stream', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => (await navigator.storage.getDirectory()).getFileHandle('e2e-selected-image-export.zip', { create: true }) })
    })
    const requests = await fixture(page)
    await page.goto('/admin/catalogo/productos')
    await page.getByText('Más acciones', { exact: true }).click()
    await page.getByRole('button', { name: 'Descargar imágenes' }).click()
    await expect(page.getByText('61 imágenes guardadas. 0 productos sin imagen.')).toBeVisible()
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await (await navigator.storage.getDirectory()).getFileHandle('e2e-selected-image-export.zip')).getFile().then(file => file.arrayBuffer()))))
    const zip = await JSZip.loadAsync(Uint8Array.from(bytes), { checkCRC32: true })
    expect(Object.keys(zip.files)).toHaveLength(62)
    await page.getByText('Más acciones', { exact: true }).click()
    const products = page.locator('.catalog-products-list')
    await products.evaluate(element => { element.scrollTop = element.scrollHeight })
    const productsBox = await products.boundingBox()
    const headerBox = await products.locator('.catalog-products-header').boundingBox()
    expect(Math.abs(headerBox!.y - productsBox!.y)).toBeLessThanOrEqual(2)
    const lastRow = products.locator('article').last()
    await lastRow.locator('summary[aria-label^="Opciones de"]').click()
    const rowMenu = lastRow.locator('.catalog-product-actions-menu')
    await expect(rowMenu).toBeVisible()
    const menuBox = await rowMenu.boundingBox()
    expect(menuBox!.y).toBeGreaterThanOrEqual(productsBox!.y)
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(productsBox!.y + productsBox!.height + 1)
    expect(requests.unexpected).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('image-export-desktop.png'), fullPage: true })
  })
})
