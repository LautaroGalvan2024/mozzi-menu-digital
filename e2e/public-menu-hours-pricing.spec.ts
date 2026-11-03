import { expect, test } from '@playwright/test'
import { routePublicCatalog } from './public-catalog-fixture'

const restaurantId = '11000000-0000-4000-8000-000000000001'
const categoryId = '12000000-0000-4000-8000-000000000001'
const productId = '13000000-0000-4000-8000-000000000001'

const catalog = {
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
}

test('shows unambiguous hours and applies reusable quantity prices', async ({ page }) => {
  await routePublicCatalog(page, catalog, 'horarios-precios-test')

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

test('applies an all-units threshold in the product dialog and cart', async ({ page }) => {
  const thresholdCatalog = {
    ...catalog,
    restaurant: { ...catalog.restaurant, isOpen: true, nextOpeningAt: null },
    categories: [{ ...catalog.categories[0]!, products: [{ ...catalog.categories[0]!.products[0]!, name: 'Yerba', basePriceCents: 450_000, quantityPrices: [], quantityThreshold: { minimumQuantity: 3, unitPriceCents: 400_000 } }] }],
  }
  await routePublicCatalog(page, thresholdCatalog, 'horarios-precios-test')
  await page.goto('/r/horarios-precios-test')
  await page.getByRole('button', { name: /Yerba/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Yerba' })
  await expect(dialog).toContainText(/Desde 3 unidades:.*4\.000,00 c\/u/)
  await dialog.getByRole('button', { name: 'Sumar uno' }).click()
  await expect(dialog.getByRole('button', { name: /Agregar/ })).toContainText(/9\.000,00/)
  await dialog.getByRole('button', { name: 'Sumar uno' }).click()
  await expect(dialog.getByRole('button', { name: /Agregar/ })).toContainText(/12\.000,00/)
  await dialog.getByRole('button', { name: 'Sumar uno' }).click()
  await expect(dialog.getByRole('button', { name: /Agregar/ })).toContainText(/16\.000,00/)
  await dialog.getByRole('button', { name: /Agregar/ }).click()
  await page.getByRole('link', { name: /Ver carrito · 4/ }).click()
  const item = page.getByRole('article', { name: 'Yerba' })
  await expect(item).toContainText(/4\.000,00 c\/u desde 3 unidades/)
  await expect(item).toContainText(/16\.000,00/)
  await page.getByRole('button', { name: 'Restar Yerba' }).click()
  await page.getByRole('button', { name: 'Restar Yerba' }).click()
  await expect(item).toContainText(/9\.000,00/)
  await expect(item).not.toContainText(/c\/u desde/)
  await page.reload()
  await expect(page.getByRole('article', { name: 'Yerba' })).toContainText(/9\.000,00/)
})
