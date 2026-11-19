import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { routePublicCatalog } from './public-catalog-fixture'

const tenant = '31310000-0000-4000-8000-000000000010'
const category = '31310000-0000-4000-8000-000000000020'
const family = '31310000-0000-4000-8000-000000000025'
const campaignId = '31310000-0000-4000-8000-000000000040'
const id = (n: number) => `31310000-0000-4000-8000-${String(n).padStart(12, '0')}`
const restaurant = { id: tenant, slug: 'campaign-shop', name: 'Almacén del Sol', tradeName: 'Almacén del Sol', description: 'Productos para compartir cada día.', whatsappPhone: '+5491111111111', address: 'San Martín 100', city: 'Rosario', timezone: 'America/Argentina/Buenos_Aires', currencyCode: 'ARS', locale: 'es-AR', logoPath: null, coverPath: null, primaryColor: '#246748', secondaryColor: '#edf6ef', deliveryEnabled: false, pickupEnabled: true, minimumOrderCents: 0, defaultPreparationMinutes: 20, isOpen: true, nextOpeningAt: null, acceptsOrders: true, storeCheckoutWhatsappEnabled: true, storeCheckoutOnlineEnabled: false }
const products = Array.from({ length: 7 }, (_, index) => ({ id: id(30 + index), categoryId: category, code: `00${index + 1}`, name: index === 0 ? 'Yerba mate selección especial con hierbas aromáticas 500 g' : `Producto selección ${index + 1}`, description: 'Descripción del producto seleccionado para la revista.', basePriceCents: 450000 + index * 10000, promotionalPriceCents: index === 0 ? 390000 : null, promotionStartsAt: null, promotionEndsAt: null, imagePath: null, available: true, featured: false, sortOrder: index, quantityPrices: index === 1 ? [{ quantity: 3, totalPriceCents: 1200000 }] : [], quantityThreshold: null, optionGroups: [], family: index < 2 ? { id: family, name: 'Yerba mate', description: '', imagePath: null, axes: ['Sabor'] } : null, variantAttributes: index < 2 ? { Sabor: index === 0 ? 'Con hierbas' : 'Tradicional' } : {} }))
const campaign = { id: campaignId, slug: campaignId, kind: 'magazine', title: 'Una selección para tu semana', description: 'Precios del catálogo, opciones por cantidad y acceso directo a cada producto.', imagePath: null, channels: ['menu', 'store'], status: 'published', startsAt: null, endsAt: null, productIds: products.map(p => p.id), targetKind: 'catalog', targetId: null, sortOrder: 0, version: 1, updatedAt: new Date().toISOString() }
const catalog = { restaurant, categories: [{ id: category, name: 'Almacén', slug: 'almacen', description: '', imagePath: null, sortOrder: 0, products }], businessHours: [], specialHours: [], deliveryZones: [], paymentMethods: [] }

test('public magazine downloads a dated multipage PDF and links to the exact variant', async ({ page }, testInfo) => {
  await routePublicCatalog(page, catalog, restaurant.slug, 'store')
  await page.route('**/rest/v1/rpc/get_public_campaign', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ campaign, restaurant, products, expired: false, serverNow: new Date().toISOString(), validUntil: null }) }))
  await page.route('**/rest/v1/rpc/get_public_campaigns', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [campaign], serverNow: new Date().toISOString(), validUntil: null }) }))
  await page.goto(`/t/${restaurant.slug}/revista/${campaignId}`)
  await expect(page.getByRole('heading', { name: campaign.title })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Ver producto' }).first()).toHaveAttribute('href', `/t/${restaurant.slug}/producto/${family}?variante=${products[0]!.id}`)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar PDF' }).click()
  const download = await downloadPromise; const path = testInfo.outputPath('revista.pdf'); await download.saveAs(path)
  const pdf = await PDFDocument.load(await readFile(path))
  expect(pdf.getPageCount()).toBe(2)
  expect(pdf.getTitle()).toContain(campaign.title)
  expect(pdf.getPage(0).node.Annots()?.size()).toBe(6)
  await page.screenshot({ path: testInfo.outputPath('revista-desktop.png'), fullPage: true })
  await page.getByRole('link', { name: 'Ver producto' }).first().click()
  await expect(page.getByRole('heading', { name: 'Yerba mate', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Con hierbas', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('mobile menu opens a shared variant and lets the buyer add it without losing the catalogue', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await routePublicCatalog(page, catalog, restaurant.slug, 'menu')
  await page.route('**/rest/v1/rpc/get_public_campaigns', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [campaign], serverNow: new Date().toISOString(), validUntil: null }) }))
  await page.goto(`/r/${restaurant.slug}?producto=${family}&variante=${products[1]!.id}`)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByLabel('Elegí tu variante')).toHaveValue(products[1]!.id)
  await page.getByRole('button', { name: /^Agregar ·/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Ver carrito · 1/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('menu-campaign-mobile.png'), fullPage: true })
})
