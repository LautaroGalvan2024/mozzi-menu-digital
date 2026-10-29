import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { routePublicCatalog } from './public-catalog-fixture'

const restaurantId = '11000000-0000-4000-8000-000000000001'
const categoryId = '12000000-0000-4000-8000-000000000001'
const familyId = '13000000-0000-4000-8000-000000000001'
const blackId = '14000000-0000-4000-8000-000000000001'
const redId = '14000000-0000-4000-8000-000000000002'
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
  await page.getByRole('link', { name: /Funda de silicona/ }).click()
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('store-detail.png'), fullPage: true })
  await page.getByRole('button', { name: 'Elegir variante' }).click()
  await page.getByLabel('Elegí tu variante').selectOption(redId)
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('store-variant.png'), fullPage: true })
  await page.getByRole('dialog').getByRole('button', { name: /Agregar/ }).click()
  await page.getByRole('link', { name: /Ver carrito · 1/ }).click()
  await expect(page).toHaveURL(/\/t\/casa-movil\/carrito$/)
  if (testInfo) await page.screenshot({ path: testInfo.outputPath('store-cart.png'), fullPage: true })
  await page.getByRole('link', { name: 'Continuar' }).click()
  await page.getByLabel('Nombre y apellido').fill('Ana Pérez')
  await page.getByLabel('Teléfono').fill('+5493492123456')
}

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
  await expect(page.getByText('Atención: fuera de horario')).toBeVisible()
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
