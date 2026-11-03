import { expect, test, type Page } from '@playwright/test'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

const restaurantId = '71000000-0000-4000-8000-000000000001'
const userId = '72000000-0000-4000-8000-000000000001'

interface ImportedProduct {
  rowRef: string
  code: string
  name: string
  category: string
  basePriceCents: number
}

interface ImportRequest {
  restaurantId: string
  batchId: string
  mode: string
  products: ImportedProduct[]
  groups: unknown[]
  options: unknown[]
}

interface ImageProduct { id: string; code: string; name: string; image_path: string | null }
async function importFixture(page: Page, imageProducts: ImageProduct[] = []) {
  const restaurant = {
    id: restaurantId, name: 'Almacén de prueba', trade_name: 'Almacén de prueba', slug: 'almacen-prueba', description: '', status: 'active',
    whatsapp_phone_e164: '+5493492123456', address: 'San Martín 123', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', currency_code: 'ARS', locale: 'es-AR',
    logo_path: null, cover_path: null, primary_color: '#4338ca', secondary_color: '#e0e7ff', delivery_enabled: true, pickup_enabled: true,
    minimum_order_cents: 0, default_preparation_minutes: 30, public_menu_enabled: true, store_enabled: false, store_ordering_policy: 'always',
    store_checkout_whatsapp_enabled: true, store_checkout_online_enabled: false, inventory_mode: 'never_enabled', inventory_cutover_id: null,
    updated_at: new Date().toISOString(),
  }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'import@example.invalid', app_metadata: {}, user_metadata: {}, factors: [], created_at: new Date().toISOString() }
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp: expiresAt })).toString('base64url'),
    Buffer.from('synthetic-e2e-signature').toString('base64url'),
  ].join('.')
  // Synthetic session and API intercepts: this suite cannot modify a live catalog.
  await page.addInitScript(({ session, selected }) => {
    localStorage.setItem('sb-e2e-auth-token', JSON.stringify(session))
    localStorage.setItem('mozzi:selected-restaurant', selected)
  }, { session: { access_token: accessToken, refresh_token: 'synthetic-e2e-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user }, selected: restaurantId })
  await page.routeWebSocket('wss://e2e.invalid/**', socket => socket.close())
  const unexpected: string[] = []
  const submissions: ImportRequest[] = []
  const knownCodes = new Map<string, string>()
  const results = new Map<string, unknown>()
  const imageUpdates: { id: string; image_path: string }[] = []
  const imageUploads: string[] = []
  await page.route('https://e2e.invalid/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let body: unknown
    if (request.method() === 'GET' && path === '/auth/v1/user') body = user
    else if (request.method() === 'GET' && path === '/rest/v1/profiles') body = { id: userId, full_name: 'Administración de prueba', email: user.email, active: true }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurant_members') body = [{ id: '76000000-0000-4000-8000-000000000001', restaurant_id: restaurantId, role: 'restaurant_admin', status: 'active', restaurants: restaurant }]
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_actor_authorization') body = { userId, isSuperAdmin: false, aal: 'aal1', memberships: [{ restaurantId, role: 'restaurant_admin', status: 'active' }] }
    else if (request.method() === 'GET' && path === '/rest/v1/restaurants') body = restaurant
    else if (request.method() === 'GET' && path === '/rest/v1/products') {
      const after = new URL(request.url()).searchParams.get('id')
      body = after?.startsWith('gt.') ? imageProducts.filter(product => product.id > after.slice(3)) : imageProducts
    }
    else if (request.method() === 'GET' && ['/rest/v1/orders', '/rest/v1/categories'].includes(path)) body = []
    else if (request.method() === 'POST' && path.startsWith('/storage/v1/object/restaurant-assets/')) { imageUploads.push(path); body = { Key: path.slice('/storage/v1/object/'.length) } }
    else if (request.method() === 'POST' && path === '/rest/v1/image_assets') body = null
    else if (request.method() === 'PATCH' && path === '/rest/v1/products') {
      const params = new URL(request.url()).searchParams
      expect(params.get('restaurant_id')).toBe(`eq.${restaurantId}`)
      expect(params.get('deleted_at')).toBe('is.null')
      const product = imageProducts.find(item => `eq.${item.id}` === params.get('id'))
      expect(product).toBeDefined()
      expect(params.get('image_path')).toBe(product!.image_path === null ? 'is.null' : `eq.${product!.image_path}`)
      product!.image_path = request.postDataJSON().image_path
      imageUpdates.push({ id: product!.id, image_path: product!.image_path! })
      body = { id: product!.id }
    }
    else if (request.method() === 'POST' && path === '/rest/v1/rpc/get_catalog_import_result') {
      const input = request.postDataJSON()
      expect(input.p_restaurant_id).toBe(restaurantId)
      body = results.get(input.p_batch_id) ?? null
    } else if (request.method() === 'POST' && path === '/functions/v1/import-products') {
      const input = request.postDataJSON() as ImportRequest
      expect(input.restaurantId).toBe(restaurantId)
      submissions.push(input)
      const products = input.products.map(product => {
        const existingId = knownCodes.get(product.code)
        const id = existingId ?? `75000000-0000-4000-8000-${String(knownCodes.size + 1).padStart(12, '0')}`
        knownCodes.set(product.code, id)
        return { rowRef: product.rowRef, code: product.code, id, outcome: existingId ? 'updated' : 'created' }
      })
      body = { batchId: input.batchId, products, errors: [], summary: { created: products.filter(product => product.outcome === 'created').length, updated: products.filter(product => product.outcome === 'updated').length, skipped: 0 } }
      results.set(input.batchId, body)
    } else {
      unexpected.push(`${request.method()} ${path}`)
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected mocked request' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { unexpected, submissions, knownCodes, imageUpdates, imageUploads }
}

function reportFile(changed = false) {
  const row = (values: Record<number, string>) => Array.from({ length: 14 }, (_, index) => values[index] ?? null)
  const header = row({ 2: 'Ref.', 5: 'Código', 7: 'Nombre', 13: 'Precio + Imp.' })
  const data = [
    row({ 1: 'Productos' }), row({ 1: 'Filtro: Lista Minorista; Activos' }), row({ 3: 'Almacén' }), header, [],
    row({ 1: '11', 5: '000123', 7: 'Arroz 1kg', 13: changed ? '$ 1.600,50' : '$ 1.500,50' }),
    row({ 1: '12', 5: '7790000000002', 7: 'Harina 1kg', 13: '$ 950,00' }),
    row({ 3: 'Bebidas' }), header, [],
    row({ 1: '13', 5: '000987', 7: 'Agua 1,5L', 13: changed ? '$ 850,00' : '$ 800,00' }),
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), 'products')
  return { name: changed ? 'productos (2).xls' : 'productos (1).xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from(XLSX.write(workbook, { type: 'array', bookType: 'biff8' }) as ArrayBuffer) }
}

test.describe('flexible catalog import', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'This suite uses only the isolated e2e.invalid mock environment.')

  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    test(`${viewport.name} uploads a ZIP alone and replays without repeating stored images`, async ({ page }) => {
      await page.setViewportSize(viewport)
      const products = [
        { id: '75000000-0000-4000-8000-000000000001', code: '000123', name: 'Yerba', image_path: null },
        { id: '75000000-0000-4000-8000-000000000002', code: '8445290067401', name: 'Alimento gatos', image_path: null },
      ]
      const fixture = await importFixture(page, products)
      await page.goto('/admin/catalogo/importar')
      await page.getByRole('button', { name: 'Sólo imágenes', exact: true }).click()
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
        const context = canvas.getContext('2d')!; context.fillStyle = '#f08010'; context.fillRect(0, 0, 2, 2)
        return canvas.toDataURL('image/png').split(',')[1]!
      })
      const zip = new JSZip().file('carpeta/000123.png', Buffer.from(png, 'base64')).file('carpeta/8445290067401_alimento.png', Buffer.from(png, 'base64'))
      const file = { name: 'imagenes.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) }
      await page.getByLabel('ZIP para actualizar imágenes').setInputFiles(file)
      await expect(page.getByLabel('SKU para carpeta/000123.png')).toHaveValue('000123')
      await expect(page.getByLabel('SKU para carpeta/8445290067401_alimento.png')).toHaveValue('8445290067401')
      expect(fixture.imageUpdates).toHaveLength(0)
      await page.getByRole('button', { name: 'Guardar imágenes', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'imágenes guardadas' })).toContainText('2 imágenes guardadas')
      expect(fixture.imageUpdates).toHaveLength(2)
      expect(fixture.imageUploads).toHaveLength(6)
      expect(fixture.submissions).toHaveLength(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.reload()
      await page.getByRole('button', { name: 'Sólo imágenes', exact: true }).click()
      await expect(page.getByText(/Hay una carga guardada/)).toBeVisible()
      await page.getByLabel('ZIP para actualizar imágenes').setInputFiles(file)
      await page.getByRole('button', { name: 'Continuar imágenes pendientes', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'imágenes guardadas' })).toContainText('2 imágenes guardadas')
      expect(fixture.imageUploads).toHaveLength(6)
      expect(fixture.imageUpdates).toHaveLength(2)
      expect(fixture.unexpected).toEqual([])
    })
  }

  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    test(`${viewport.name} recognizes a grouped XLS and remembers the format for daily updates`, async ({ page }) => {
      await page.setViewportSize(viewport)
      const requests = await importFixture(page)
      await page.goto('/admin/catalogo/importar')
      await expect(page.getByRole('heading', { name: 'Importación masiva' })).toBeVisible()
      const uploader = page.locator('input[type="file"][accept^=".xlsx"]')
      await uploader.setInputFiles(reportFile())
      await expect(page.getByRole('heading', { name: 'Relacioná tus columnas' })).toBeVisible()
      await expect(page.getByLabel('Fila de encabezados', { exact: true })).toHaveValue('4')
      await expect(page.getByLabel('Columna para Nombre', { exact: true })).toHaveValue('7')
      await expect(page.getByLabel('Columna para Código / SKU', { exact: true })).toHaveValue('5')
      await expect(page.getByLabel('Columna para Precio de venta', { exact: true })).toHaveValue('13')
      await expect(page.getByLabel('Dónde están las categorías')).toHaveValue('section')
      await expect(page.getByLabel('Columna de los títulos de categoría')).toHaveValue('3')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(page.getByRole('row').filter({ hasText: 'Arroz 1kg' })).toContainText('Almacén')
      await page.getByLabel('Nombre del formato').fill('Sistema del almacén')
      expect(requests.submissions).toHaveLength(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.getByRole('heading', { name: 'Importación masiva' }).click()
      await page.screenshot({ path: `.tmp/catalog-import-${viewport.name}-mapping.png`, fullPage: true })
      await page.getByRole('button', { name: 'Revisar importación', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Vista previa' })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: 'Arroz 1kg' })).toContainText('1500.50')
      expect(requests.submissions).toHaveLength(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.getByRole('heading', { name: 'Importación masiva' }).click()
      await page.screenshot({ path: `.tmp/catalog-import-${viewport.name}-preview.png`, fullPage: true })
      await page.getByRole('button', { name: 'Importar catálogo', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Importación terminada' })).toContainText('3 creados, 0 actualizados')
      expect(requests.submissions).toHaveLength(1)
      expect(requests.submissions[0]).toMatchObject({ restaurantId, mode: 'create_or_update', groups: [], options: [] })
      expect(requests.submissions[0]?.products).toEqual([
        { rowRef: '6', code: '000123', name: 'Arroz 1kg', category: 'Almacén', basePriceCents: 150050 },
        { rowRef: '7', code: '7790000000002', name: 'Harina 1kg', category: 'Almacén', basePriceCents: 95000 },
        { rowRef: '11', code: '000987', name: 'Agua 1,5L', category: 'Bebidas', basePriceCents: 80000 },
      ])

      // A new daily file reuses mapping, not the prior price values or batch.
      await uploader.setInputFiles(reportFile(true))
      await expect(page.getByRole('status').filter({ hasText: 'Reconocimos el formato guardado' })).toContainText('Sistema del almacén')
      await expect(page.getByLabel('Dónde están las categorías')).toHaveValue('section')
      await page.getByRole('button', { name: 'Revisar importación', exact: true }).click()
      await expect(page.getByRole('row').filter({ hasText: 'Arroz 1kg' })).toContainText('1600.50')
      await page.getByRole('button', { name: 'Importar catálogo', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Importación terminada' })).toContainText('0 creados, 3 actualizados')
      expect(requests.submissions).toHaveLength(2)
      expect(requests.submissions[1]?.batchId).not.toBe(requests.submissions[0]?.batchId)
      expect(requests.submissions[1]?.products.map(product => product.code)).toEqual(['000123', '7790000000002', '000987'])
      expect(requests.submissions[1]?.products.map(product => product.basePriceCents)).toEqual([160050, 95000, 85000])
      expect(requests.knownCodes.size).toBe(3)
      expect(requests.unexpected).toEqual([])
    })
  }

  test('manual column mapping exposes unknown data and blocks invalid rows until reviewed', async ({ page }) => {
    const requests = await importFixture(page)
    await page.goto('/admin/catalogo/importar')
    await page.locator('input[type="file"][accept^=".xlsx"]').setInputFiles({
      name: 'exportacion.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Clave propia;Texto comercial;Tarifa mostrador;Costo interno\nA-1;Yerba 1kg;2500,00;1000\nA-2;Azúcar 1kg;sin precio;500'),
    })
    await expect(page.getByRole('heading', { name: 'Relacioná tus columnas' })).toBeVisible()
    await expect(page.getByText('Columnas que no se importarán', { exact: true })).toBeVisible()
    await page.getByLabel('Fila de encabezados', { exact: true }).fill('1')
    await page.getByLabel('Columna para Código / SKU', { exact: true }).selectOption('0')
    await page.getByLabel('Columna para Nombre', { exact: true }).selectOption('1')
    await page.getByLabel('Columna para Precio de venta', { exact: true }).selectOption('2')
    await page.getByLabel('Dónde están las categorías').selectOption('fixed')
    await page.getByLabel('Categoría para todos los productos').fill('Almacén')
    await expect(page.getByRole('button', { name: 'Revisar importación', exact: true })).toBeDisabled()
    await expect(page.getByRole('alert')).toContainText(/fila 3/i)
    expect(requests.submissions).toHaveLength(0)
    await page.getByRole('button', { name: 'Excluir fila 3', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Revisar importación', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Revisar importación', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Vista previa' })).toBeVisible()
    await page.getByRole('button', { name: 'Importar catálogo', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Importación terminada' })).toContainText('1 creados')
    expect(requests.submissions[0]?.products).toEqual([{ rowRef: '2', code: 'A-1', name: 'Yerba 1kg', category: 'Almacén', basePriceCents: 250000 }])
    expect(requests.unexpected).toEqual([])
  })
})
