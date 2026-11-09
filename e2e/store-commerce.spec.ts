import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { routePublicCatalog } from './public-catalog-fixture'

const restaurantId = '11000000-0000-4000-8000-000000000001'
const categoryId = '12000000-0000-4000-8000-000000000001'
const familyId = '13000000-0000-4000-8000-000000000001'
const blackId = '14000000-0000-4000-8000-000000000001'
const redId = '14000000-0000-4000-8000-000000000002'
const simpleId = '14000000-0000-4000-8000-000000000003'
const paymentId = '15000000-0000-4000-8000-000000000001'
const actionId = '16000000-0000-4000-8000-000000000001'
const token = 'a'.repeat(43)
const until = new Date(Date.now() + 30 * 60 * 1000).toISOString()

function product(id: string, color: string, price: number) {
  return { id, categoryId, code: `FUN-${color}`, name: `Funda ${color}`, description: 'Silicona suave y protección reforzada para tu teléfono.', basePriceCents: price, promotionalPriceCents: null, promotionStartsAt: null, promotionEndsAt: null, imagePath: null, available: true, featured: false, sortOrder: 0, quantityPrices: [], optionGroups: [], family: { id: familyId, name: 'Funda de silicona', description: 'Elegí el color que va con vos. Compatible con iPhone 15.', imagePath: null, axes: ['Modelo', 'Color'] }, variantAttributes: { Modelo: 'iPhone 15', Color: color } }
}
const catalog = {
  restaurant: { id: restaurantId, name: 'Casa Móvil', tradeName: 'Casa Móvil', slug: 'casa-movil', description: 'Accesorios que acompañan tu día. Encontrá tu modelo y elegí tu color.', whatsappPhone: '+5493492123456', address: 'San Martín 123', city: 'Rafaela', timezone: 'America/Argentina/Cordoba', currencyCode: 'ARS', locale: 'es-AR', logoPath: null, coverPath: null, primaryColor: '#4338ca', secondaryColor: '#e0e7ff', deliveryEnabled: false, pickupEnabled: true, minimumOrderCents: 0, defaultPreparationMinutes: 30, isOpen: false, acceptsOrders: true, nextOpeningAt: null, channel: 'store', storeCheckoutWhatsappEnabled: true, storeCheckoutOnlineEnabled: true },
  categories: [{ id: categoryId, name: 'Fundas', slug: 'fundas', description: '', imagePath: null, sortOrder: 0, products: [product(blackId, 'Negro', 950000), product(redId, 'Rojo', 1050000)] }],
  businessHours: [], specialHours: [], deliveryZones: [],
  paymentMethods: [{ id: paymentId, code: 'efectivo', name: 'Efectivo al retirar', description: '', provider: null, adjustmentType: 'none', adjustmentScope: 'subtotal', adjustmentBps: 0, adjustmentFixedCents: 0, transferAlias: null, accountHolder: null, bankName: null, instructions: null, sortOrder: 0 }],
}
const summary = { order: { actionId, displayNumber: 'CM-001', status: 'generated', totalCents: 1050000, currencyCode: 'ARS', createdAt: new Date().toISOString() }, payment: { status: 'pending', checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=test', expiresAt: until }, recoveryToken: token, recoveryExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }

async function fixture(page: Page) {
  await routePublicCatalog(page, catalog, 'casa-movil', 'store')
}
async function addRedVariant(page: Page, testInfo?: TestInfo) {
  await page.goto('/t/casa-movil')
  await expect(page.getByRole('heading', { name: 'Funda de silicona' })).toHaveCount(1)
  await page.getByRole('link', { name: 'Ver Funda de silicona' }).click()
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('store-detail.png'), fullPage: true })
  await page.getByRole('button', { name: 'Rojo' }).click()
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('store-variant.png'), fullPage: true })
  const addButton = page.getByRole('button', { name: /Agregar al carrito/ })
  await addButton.click()
  await expect.poll(async () => addButton.evaluate(button => {
    const rect = button.getBoundingClientRect()
    const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return topmost === button || button.contains(topmost)
  })).toBe(true)
  await page.getByRole('link', { name: /Ver carrito · 1/ }).click()
  await expect(page).toHaveURL(/\/t\/casa-movil\/carrito$/)
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('store-cart.png'), fullPage: true })
  await page.getByRole('link', { name: 'Continuar' }).click()
  await page.getByLabel('Nombre y apellido').fill('Ana Pérez')
  await page.getByLabel('Teléfono').fill('+5493492123456')
}

test('store landing uses a responsive vertical cover hero and product detail keeps a compact header', async ({ page }, testInfo) => {
  const coveredCatalog = structuredClone(catalog)
  coveredCatalog.restaurant.coverPath = 'restaurants/casa-movil/cover-w900-900.webp'
  coveredCatalog.restaurant.tradeName = 'Casa Móvil Accesorios y Tecnología'
  coveredCatalog.restaurant.description = 'Accesorios pensados para acompañarte todos los días, con modelos, colores y opciones para elegir sin perder tiempo.'
  coveredCatalog.restaurant.address = 'Avenida San Martín 1234, local 8, Rafaela'
  coveredCatalog.restaurant.deliveryEnabled = true
  ;(coveredCatalog.categories[0] as Record<string, unknown>).iconKey = 'snacks'
  await routePublicCatalog(page, coveredCatalog, 'casa-movil', 'store')
  await page.route('https://e2e.invalid/storage/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="900"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#4338ca"/><stop offset="1" stop-color="#fb7185"/></linearGradient></defs><rect width="500" height="900" fill="url(#g)"/></svg>',
  }))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/t/casa-movil')
  const hero = page.locator('.store-hero')
  await expect(hero).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Casa Móvil Accesorios y Tecnología', level: 1 })).toBeVisible()
  const explore = page.getByRole('link', { name: 'Explorar productos' })
  await expect(explore).toBeVisible()
  await expect(explore).toHaveAttribute('href', '#store-products')
  await expect(page.locator('#store-products')).toHaveCount(1)
  await expect(page.getByText('Envíos locales', { exact: true })).toBeVisible()
  await expect(page.locator('.store-category-image svg')).toHaveAttribute('data-category-icon', 'snacks')
  await expect(page.getByText('Avenida San Martín 1234, local 8, Rafaela', { exact: true })).toBeVisible()
  const cover = hero.locator('img')
  await expect(cover).toHaveAttribute('fetchpriority', 'high')
  await expect(cover).toHaveAttribute('srcset', /320w.*640w.*900w/)
  const mobileMediaHeight = (await hero.locator('.store-hero-media').boundingBox())?.height ?? 0
  const exploreBox = await explore.boundingBox()
  expect(mobileMediaHeight).toBeGreaterThanOrEqual(190)
  expect(mobileMediaHeight).toBeLessThanOrEqual(220)
  expect(exploreBox).not.toBeNull()
  await expect.poll(() => cover.evaluate(element => getComputedStyle(element).objectFit)).toBe('contain')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('store-cover-vertical-mobile.png'), fullPage: true })

  await page.getByRole('link', { name: 'Ver Funda de silicona' }).click()
  await expect(page.locator('.store-hero')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Funda de silicona', level: 1 })).toBeVisible()
  await expect(page.locator('.store-header')).toHaveClass(/store-header-compact/)
  await page.screenshot({ path: testInfo.outputPath('store-detail-compact-mobile.png'), fullPage: true })

  await page.goto('/t/casa-movil/producto/ffffffff-ffff-4fff-8fff-ffffffffffff')
  await expect(page.getByRole('heading', { name: 'Producto no disponible', level: 1 })).toBeVisible()

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/t/casa-movil')
  const desktopMediaHeight = (await page.locator('.store-hero-media').boundingBox())?.height ?? 0
  expect(desktopMediaHeight).toBeGreaterThanOrEqual(330)
  expect(desktopMediaHeight).toBeLessThanOrEqual(360)
  await page.screenshot({ path: testInfo.outputPath('store-cover-vertical-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto('/t/casa-movil')
  await expect(page.getByRole('heading', { name: 'Casa Móvil Accesorios y Tecnología', level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('store-cover-vertical-320.png'), fullPage: true })
})

test('store preserves a wide cover and uses a lower branded fallback without inventing imagery', async ({ page }, testInfo) => {
  const wideCatalog = structuredClone(catalog)
  wideCatalog.restaurant.coverPath = 'restaurants/casa-movil/cover-w900-900.webp'
  await routePublicCatalog(page, wideCatalog, 'casa-movil', 'store')
  await page.route('https://e2e.invalid/storage/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400"><defs><linearGradient id="g"><stop stop-color="#0f766e"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="1200" height="400" fill="url(#g)"/></svg>',
  }))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/t/casa-movil')
  const coveredHero = page.locator('.store-hero.has-cover')
  const cover = coveredHero.locator('img')
  await expect(cover).toBeVisible()
  await expect.poll(() => cover.evaluate(image => (image as HTMLImageElement).naturalWidth / (image as HTMLImageElement).naturalHeight)).toBeGreaterThan(2)
  const coveredHeight = (await coveredHero.boundingBox())?.height ?? 0
  await page.screenshot({ path: testInfo.outputPath('store-cover-horizontal-desktop.png'), fullPage: true })

  await page.unroute('**/rest/v1/rpc/get_public_*')
  const fallbackCatalog = structuredClone(catalog)
  fallbackCatalog.restaurant.slug = 'casa-neutral'
  await routePublicCatalog(page, fallbackCatalog, 'casa-neutral', 'store')
  await page.goto('/t/casa-neutral')
  const fallbackHero = page.locator('.store-hero.has-brand-fallback')
  await expect(fallbackHero).toBeVisible()
  await expect(fallbackHero.locator('img')).toHaveCount(0)
  expect((await fallbackHero.boundingBox())?.height ?? coveredHeight).toBeLessThan(coveredHeight)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('store-fallback-desktop.png'), fullPage: true })
})

test('store merchandises real offers, quick-adds simple products and restores URL filters after detail', async ({ page }, testInfo) => {
  const merchandise = structuredClone(catalog)
  const promotedFamilyVariant = merchandise.categories[0]!.products[1]! as Record<string, unknown>
  promotedFamilyVariant.promotionalPriceCents = 1000000
  promotedFamilyVariant.promotionStartsAt = '2026-11-01T00:00:00.000Z'
  promotedFamilyVariant.promotionEndsAt = '2026-11-30T00:00:00.000Z'
  ;(merchandise.categories[0]!.products as Array<Record<string, unknown>>).push({
    id: simpleId,
    categoryId,
    code: 'CARGADOR-20W',
    name: 'Cargador rápido 20W',
    description: 'Carga rápida para llevar todos los días.',
    basePriceCents: 2400000,
    promotionalPriceCents: 1990000,
    promotionStartsAt: '2026-11-01T00:00:00.000Z',
    promotionEndsAt: '2026-11-30T00:00:00.000Z',
    imagePath: null,
    available: true,
    featured: true,
    sortOrder: 2,
    quantityPrices: [],
    optionGroups: [],
    family: null,
    variantAttributes: {},
  })
  await routePublicCatalog(page, merchandise, 'casa-movil', 'store')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/t/casa-movil')

  const offers = page.getByRole('region', { name: 'Ofertas para aprovechar' })
  const featured = page.getByRole('region', { name: 'Productos destacados' })
  await expect(offers.getByText('Cargador rápido 20W')).toBeVisible()
  await expect(featured.getByText('Cargador rápido 20W')).toBeVisible()
  const familyOffer = offers.locator('.store-product-card').filter({ hasText: 'Funda de silicona' })
  await expect(familyOffer.getByText('5% menos').first()).toBeVisible()
  await expect(familyOffer.getByText(/10\.000,00/)).toBeVisible()
  await offers.getByRole('button', { name: 'Agregar' }).click()
  await expect(page.getByRole('link', { name: /Ver carrito, 1 productos/ })).toBeVisible()

  await offers.getByRole('button', { name: 'Ver todos' }).click()
  await expect(page).toHaveURL(/section=offers/)
  await expect(page.locator('.store-hero')).toHaveCount(0)
  const search = page.getByRole('textbox', { name: 'Buscar productos' })
  await search.fill('Cargador')
  await expect(page).toHaveURL(/q=Cargador/)
  await page.getByRole('link', { name: 'Ver Cargador rápido 20W' }).click()
  await expect(page.getByRole('heading', { name: 'Cargador rápido 20W', level: 1 })).toBeVisible()
  await page.getByRole('link', { name: 'Volver a productos' }).click()
  await expect(page).toHaveURL(/section=offers.*q=Cargador|q=Cargador.*section=offers/)
  await expect(page.getByRole('textbox', { name: 'Buscar productos' })).toHaveValue('Cargador')
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const savedListScroll = await page.evaluate(() => window.scrollY)
  await page.getByRole('link', { name: 'Ver Cargador rápido 20W' }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(10)
  const detailHeading = await page.getByRole('heading', { name: 'Cargador rápido 20W', level: 1 }).boundingBox()
  expect(detailHeading?.y ?? -1).toBeGreaterThanOrEqual(0)
  await page.getByRole('link', { name: 'Volver a productos' }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(Math.max(1, savedListScroll - 5))
  await page.screenshot({ path: testInfo.outputPath('store-merchandising-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.locator('.store-identity').click()
  await expect(page).toHaveURL(/\/t\/casa-movil$/)
  await expect(page.getByRole('textbox', { name: 'Buscar productos' })).toHaveValue('')
  await page.goBack()
  await expect(page).toHaveURL(/section=offers.*q=Cargador|q=Cargador.*section=offers/)
  await expect(page.getByRole('textbox', { name: 'Buscar productos' })).toHaveValue('Cargador')
  await page.goForward()
  await expect(page).toHaveURL(/\/t\/casa-movil$/)
  await expect(page.getByRole('textbox', { name: 'Buscar productos' })).toHaveValue('')

  await page.goto('/t/casa-movil?category=ffffffff-ffff-4fff-8fff-ffffffffffff')
  await expect(page).toHaveURL(/\/t\/casa-movil$/)
  await expect(page.getByRole('heading', { name: 'Casa Móvil', level: 1 })).toBeVisible()
})

test('store variants and WhatsApp checkout share catalog while keeping menu cart intact', async ({ page }, testInfo) => {
  await fixture(page)
  await page.addInitScript(() => localStorage.setItem('mozzi:cart:casa-movil', '[]'))
  let received: Record<string, unknown> | null = null
  await page.route('**/functions/v1/create-order', async route => {
    received = route.request().postDataJSON()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: summary.order, whatsapp: { phone: '+5493492123456', message: 'CM-001 · Funda iPhone 15 Rojo', url: 'https://wa.me/5493492123456?text=CM-001' }, clientEventToken: null, recoveryToken: token, recoveryExpiresAt: until }) })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/t/casa-movil')
  await expect(page.getByText('Recibimos pedidos')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ver horarios' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('store-mobile.png'), fullPage: true })
  await addRedVariant(page, testInfo)
  await expect(page.getByLabel('Teléfono')).toHaveAccessibleDescription(/WhatsApp con código de país/)
  await page.screenshot({ path: testInfo.outputPath('store-checkout-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Generar pedido' }).click()
  await expect(page).toHaveURL(/\/t\/casa-movil\/pedido-generado$/)
  await expect(page.getByRole('button', { name: 'Abrir WhatsApp', exact: true })).toBeVisible()
  expect(received).toMatchObject({ channel: 'store', checkoutMode: 'whatsapp', items: [{ productId: redId, quantity: 1 }] })
  expect(await page.evaluate(() => localStorage.getItem('mozzi:cart:casa-movil'))).toBe('[]')
  await expect(page.getByRole('link', { name: 'Volver a la tienda' })).toHaveAttribute('href', '/t/casa-movil')
})

test('an untracked variant completes checkout while its zero-stock sibling stays unavailable', async ({ page }) => {
  // Public availability comes from the server: black has zero stock; red has no balance.
  const mixedCatalog = structuredClone(catalog)
  mixedCatalog.categories[0]!.products[0]!.available = false
  await routePublicCatalog(page, mixedCatalog, 'casa-movil', 'store')
  let received: Record<string, unknown> | null = null
  await page.route('**/functions/v1/create-order', async route => {
    received = route.request().postDataJSON()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: summary.order, whatsapp: { phone: '+5493492123456', message: 'CM-001 · Funda sin control de stock', url: 'https://wa.me/5493492123456?text=CM-001' }, clientEventToken: null, recoveryToken: token, recoveryExpiresAt: until }) })
  })
  await page.goto('/t/casa-movil')
  await expect(page.getByText('Agotado', { exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Ver Funda de silicona' }).click()
  await expect(page.getByRole('button', { name: /Negro.*Agotado/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Rojo' }).click()
  await page.getByRole('button', { name: /Agregar al carrito/ }).click()
  await page.getByRole('link', { name: /Ver carrito · 1/ }).click()
  await page.getByRole('link', { name: 'Continuar' }).click()
  await page.getByLabel('Nombre y apellido').fill('Ana Pérez')
  await page.getByLabel('Teléfono').fill('+5493492123456')
  await page.getByRole('button', { name: 'Generar pedido' }).click()
  await expect(page).toHaveURL(/\/t\/casa-movil\/pedido-generado$/)
  await expect(page.getByRole('button', { name: 'Abrir WhatsApp', exact: true })).toBeVisible()
  expect(received).toMatchObject({ channel: 'store', checkoutMode: 'whatsapp', items: [{ productId: redId, quantity: 1 }] })
})

test('store online checkout confirms server total and ignores forged provider success query', async ({ page }, testInfo) => {
  await fixture(page)
  let received: Record<string, unknown> | null = null
  let approved = false
  await page.route('**/functions/v1/create-payment', async route => {
    received = route.request().postDataJSON()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summary) })
  })
  await page.route('**/functions/v1/payment-status', async route => {
    expect(route.request().postDataJSON()).toEqual({ actionId, recoveryToken: token })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(approved ? { ...summary, payment: { ...summary.payment, status: 'approved' } } : summary) })
  })
  await addRedVariant(page)
  await page.getByRole('radio', { name: /Pagar online/ }).check()
  await page.screenshot({ path: testInfo.outputPath('store-checkout-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Continuar al pago' }).click()
  await expect(page.getByRole('heading', { name: 'Pago pendiente de confirmación' })).toBeVisible()
  expect(received).toMatchObject({ channel: 'store', checkoutMode: 'online', items: [{ productId: redId, quantity: 1 }] })
  await expect(page.getByRole('link', { name: 'Continuar en Mercado Pago' })).toHaveAttribute('href', summary.payment.checkoutUrl)
  await page.goto(`/t/casa-movil/pago?status=approved&payment_id=untrusted&order=${actionId}`)
  await expect(page.getByRole('heading', { name: 'Pago pendiente de confirmación' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pago aprobado' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('store-payment-pending.png'), fullPage: true })
  approved = true
  await page.getByRole('button', { name: 'Actualizar estado' }).click()
  await expect(page.getByRole('heading', { name: 'Pago aprobado' })).toBeVisible()
  await expect(page.getByText(/En breve, el comercio se comunicará por WhatsApp/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continuar en Mercado Pago' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('store-payment-approved-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('store-payment-approved-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
