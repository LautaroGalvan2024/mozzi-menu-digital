import { expect, test } from '@playwright/test'

const restaurantId = '10000000-0000-4000-8000-000000000001'
const categoryId = '20000000-0000-4000-8000-000000000001'
const productId = '30000000-0000-4000-8000-000000000001'
const paymentMethodId = '40000000-0000-4000-8000-000000000001'
const actionId = '50000000-0000-4000-8000-000000000001'

test('a successful checkout keeps the confirmation visible while clearing the cart', async ({ page }) => {
  let whatsappOpenedRegistrations = 0
  await page.route('**/rest/v1/rpc/get_public_menu', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        restaurant: {
          id: restaurantId,
          name: 'Checkout Test',
          tradeName: 'Checkout Test',
          slug: 'checkout-test',
          description: 'Flujo de confirmación',
          whatsappPhone: '+5493492123456',
          address: 'Calle 123',
          city: 'Rafaela',
          timezone: 'America/Argentina/Cordoba',
          currencyCode: 'ARS',
          locale: 'es-AR',
          logoPath: null,
          coverPath: null,
          primaryColor: '#ea580c',
          secondaryColor: '#1c1917',
          deliveryEnabled: false,
          pickupEnabled: true,
          minimumOrderCents: 0,
          defaultPreparationMinutes: 30,
          isOpen: true,
          nextOpeningAt: null,
        },
        categories: [{
          id: categoryId,
          name: 'Principales',
          slug: 'principales',
          description: '',
          imagePath: null,
          sortOrder: 0,
          products: [{
            id: productId,
            categoryId,
            code: 'TEST-1',
            name: 'Producto de prueba',
            description: 'Producto para validar checkout',
            basePriceCents: 250000,
            promotionalPriceCents: null,
            promotionStartsAt: null,
            promotionEndsAt: null,
            imagePath: null,
            available: true,
            featured: false,
            sortOrder: 0,
            optionGroups: [],
          }],
        }],
        businessHours: [],
        specialHours: [],
        paymentMethods: [{
          id: paymentMethodId,
          code: 'cash',
          name: 'Efectivo',
          description: 'Al retirar',
          adjustmentType: 'none',
          adjustmentScope: 'total',
          adjustmentBps: 0,
          adjustmentFixedCents: 0,
          transferAlias: null,
          accountHolder: null,
          bankName: null,
          instructions: null,
          sortOrder: 0,
        }],
        deliveryZones: [],
      }),
    })
  })

  await page.route('**/functions/v1/create-order', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        order: {
          actionId,
          displayNumber: 'TEST-000001',
          status: 'generated',
          totalCents: 250000,
          currencyCode: 'ARS',
          createdAt: '2026-09-29T15:00:00.000Z',
        },
        whatsapp: {
          phone: '+5493492123456',
          message: 'Pedido TEST-000001',
          url: 'https://wa.me/5493492123456?text=Pedido%20TEST-000001',
        },
        clientEventToken: 'abcdefghijklmnopqrstuvwxyz012345',
        clientEventExpiresAt: '2026-09-29T15:30:00.000Z',
        idempotentReplay: false,
      }),
    })
  })
  await page.route('**/functions/v1/register-whatsapp-opened', async (route) => {
    whatsappOpenedRegistrations += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ registered: true }) })
  })
  await page.route('https://wa.me/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp</title>' })
  })

  await page.goto('/r/checkout-test')
  await page.getByRole('button', { name: /Producto de prueba/ }).click()
  await page.getByRole('button', { name: /Agregar ·/ }).click()
  await page.getByRole('link', { name: /Ver carrito/ }).click()
  await page.getByRole('link', { name: 'Continuar' }).click()
  await page.getByLabel('Nombre y apellido').fill('Cliente de prueba')
  await page.getByLabel('Teléfono').fill('+5493492123456')
  await page.getByRole('button', { name: 'Generar pedido' }).click()

  await expect(page).toHaveURL('/r/checkout-test/pedido-generado')
  await expect(page.getByRole('heading', { name: 'TEST-000001' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Abrir WhatsApp' })).toBeVisible()
  const whatsappWeb = page.getByRole('link', { name: 'Abrir WhatsApp Web' })
  await expect(whatsappWeb).toBeVisible()
  const webDestination = new URL((await whatsappWeb.getAttribute('href')) ?? '')
  expect(webDestination.origin).toBe('https://web.whatsapp.com')
  expect(webDestination.pathname).toBe('/send')
  expect(webDestination.searchParams.get('phone')).toBe('5493492123456')
  expect(webDestination.searchParams.get('text')).toBe('Pedido TEST-000001')
  await expect(whatsappWeb).toHaveAttribute('target', '_blank')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mozzi:cart:checkout-test'))).toBe('[]')
  await page.getByRole('button', { name: 'Abrir WhatsApp' }).click()
  await expect(page).toHaveURL(/wa\.me\/5493492123456\?text=Pedido%20TEST-000001/)
  expect(whatsappOpenedRegistrations).toBe(1)
})
