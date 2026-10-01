import { expect, test } from '@playwright/test'

const restaurantId = '11000000-0000-4000-8000-000000000001'
const categoryId = '12000000-0000-4000-8000-000000000001'
const productId = '13000000-0000-4000-8000-000000000001'

test('shows unambiguous hours and applies reusable quantity prices', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_public_menu', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        restaurant: {
          id: restaurantId,
          name: 'El Nieto E2E',
          tradeName: 'El Nieto E2E',
          slug: 'horarios-precios-test',
          description: '',
          whatsappPhone: '+5493492123456',
          address: 'Calle 123',
          city: 'Rafaela',
          timezone: 'America/Argentina/Cordoba',
          currencyCode: 'ARS',
          locale: 'es-AR',
          logoPath: null,
          coverPath: null,
          primaryColor: '#412f06',
          secondaryColor: '#f7e845',
          deliveryEnabled: true,
          pickupEnabled: true,
          minimumOrderCents: 0,
          defaultPreparationMinutes: 30,
          isOpen: false,
          nextOpeningAt: '2026-10-01T22:30:00+00:00',
        },
        categories: [{
          id: categoryId,
          name: 'Hamburguesas',
          slug: 'hamburguesas',
          description: '',
          imagePath: null,
          sortOrder: 0,
          products: [{
            id: productId,
            categoryId,
            code: 'BUR-COMBO',
            name: 'Hamburguesa con combo',
            description: 'Precio especial por cantidad',
            basePriceCents: 1_000_000,
            promotionalPriceCents: null,
            promotionStartsAt: null,
            promotionEndsAt: null,
            imagePath: null,
            available: true,
            featured: false,
            sortOrder: 0,
            quantityPrices: [{ quantity: 2, totalPriceCents: 1_800_000 }],
            optionGroups: [],
          }],
        }],
        businessHours: [
          { id: '14000000-0000-4000-8000-000000000001', dayOfWeek: 1, slotIndex: 0, opensAt: '11:30:00', closesAt: '14:00:00', spansNextDay: false },
          { id: '14000000-0000-4000-8000-000000000002', dayOfWeek: 1, slotIndex: 1, opensAt: '19:30:00', closesAt: '23:30:00', spansNextDay: false },
          { id: '14000000-0000-4000-8000-000000000003', dayOfWeek: 5, slotIndex: 0, opensAt: '19:30:00', closesAt: '00:00:00', spansNextDay: true },
        ],
        specialHours: [{
          id: '15000000-0000-4000-8000-000000000001',
          date: '2099-12-24',
          isClosed: true,
          slotIndex: 0,
          opensAt: null,
          closesAt: null,
          spansNextDay: false,
          reason: 'Nochebuena',
        }],
        paymentMethods: [],
        deliveryZones: [],
      }),
    })
  })

  await page.goto('/r/horarios-precios-test')

  const hoursButton = page.getByRole('button', { name: /Próxima apertura: 01\/10, 19:30 hs.*Ver horarios/ })
  await expect(hoursButton).toBeVisible()
  await hoursButton.click()

  const hoursDialog = page.getByRole('dialog', { name: 'El Nieto E2E' })
  await expect(hoursDialog).toBeVisible()
  await expect(hoursDialog.getByTestId('weekly-day-1')).toContainText('11:30 a 14:00 hs')
  await expect(hoursDialog.getByTestId('weekly-day-1')).toContainText('19:30 a 23:30 hs')
  await expect(hoursDialog.getByTestId('weekly-day-2')).toContainText('Cerrado')
  await expect(hoursDialog.getByTestId('weekly-day-5')).toContainText('día siguiente')
  await expect(hoursDialog).toContainText('Nochebuena')
  await hoursDialog.getByRole('button', { name: 'Cerrar horarios' }).click()

  await page.getByRole('button', { name: /Hamburguesa con combo/ }).click()
  const productDialog = page.getByRole('dialog', { name: 'Hamburguesa con combo' })
  await expect(productDialog).toContainText(/2 por.*18\.000,00/)
  await productDialog.getByRole('button', { name: 'Sumar uno' }).click()
  await productDialog.getByRole('button', { name: 'Sumar uno' }).click()
  await expect(productDialog.getByRole('button', { name: /Agregar/ })).toContainText(/28\.000,00/)
  await productDialog.getByRole('button', { name: /Agregar/ }).click()

  await expect(page.getByRole('link', { name: /Ver carrito · 3/ })).toContainText(/28\.000,00/)
})
