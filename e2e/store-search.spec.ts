import { expect, test, type Request } from '@playwright/test'
import { routePublicCatalog } from './public-catalog-fixture'

const slug = 'almacen-busqueda'
const categoryId = '72000000-0000-4000-8000-000000000001'
const productNames = ['Agua mineral 2 L', 'Agua con gas 1,5 L', 'Aceite de girasol', 'Arroz largo fino']
const catalog = {
  restaurant: {
    id: '71000000-0000-4000-8000-000000000001',
    name: 'Almacén del barrio', tradeName: 'Almacén del barrio', slug,
    description: 'Todo para tu compra, en un solo lugar.',
    whatsappPhone: '+5493492123456', address: 'San Martín 123', city: 'Rafaela',
    timezone: 'America/Argentina/Cordoba', currencyCode: 'ARS', locale: 'es-AR',
    logoPath: null, coverPath: null, primaryColor: '#4338ca', secondaryColor: '#e0e7ff',
    deliveryEnabled: true, pickupEnabled: true, minimumOrderCents: 0,
    defaultPreparationMinutes: 30, isOpen: true, acceptsOrders: true, nextOpeningAt: null,
    channel: 'store', storeCheckoutWhatsappEnabled: true, storeCheckoutOnlineEnabled: false,
  },
  categories: [{
    id: categoryId, name: 'Almacén', slug: 'almacen', description: '', imagePath: null, sortOrder: 0,
    products: productNames.map((name, index) => ({
      id: `74000000-0000-4000-8000-00000000000${index + 1}`,
      categoryId, code: `BUSQUEDA-${index + 1}`, name, description: '',
      basePriceCents: 100000, promotionalPriceCents: null, promotionStartsAt: null, promotionEndsAt: null,
      imagePath: null, available: true, featured: false, sortOrder: index,
      quantityPrices: [], optionGroups: [], family: null, variantAttributes: {},
    })),
  }],
  businessHours: [], specialHours: [], deliveryZones: [], paymentMethods: [],
}

function searchPhrase(request: Request) {
  if (!request.url().endsWith('/rpc/get_public_store_catalog_page')) return null
  const body = request.postDataJSON() as { p_search?: string | null }
  return body.p_search?.toLocaleLowerCase('es') ?? null
}

test('typing through slow searches preserves the focused input, layout and newest results', async ({ page }) => {
  await routePublicCatalog(page, catalog, slug, 'store')
  // Early requests finish after the latest one, as can happen on a slow network.
  // The final request still takes 500 ms, leaving a visible pending interval.
  const latency: Record<string, number> = { ag: 1800, agua: 1300, 'agua con': 500 }
  await page.route('**/rest/v1/rpc/get_public_store_catalog_page', async route => {
    const phrase = searchPhrase(route.request())
    if (phrase && latency[phrase]) await new Promise(resolve => setTimeout(resolve, latency[phrase]))
    await route.fallback()
  })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`/t/${slug}`)
  const search = page.getByRole('textbox', { name: 'Buscar productos' })
  const cards = page.locator('.store-grid .store-product-card')
  await expect(cards).toHaveCount(productNames.length)
  await search.click()
  const originalInput = await search.elementHandle()
  const initialY = (await search.boundingBox())!.y
  const loadingMonitor = await page.evaluateHandle(() => {
    const state = { flashed: false, observer: null as MutationObserver | null }
    state.observer = new MutationObserver(records => {
      for (const record of records) {
        if ([...record.addedNodes].some(node => node.textContent?.includes('Preparando la tienda'))) state.flashed = true
      }
    })
    state.observer.observe(document.body, { childList: true, subtree: true })
    return state
  })

  const responses = ['ag', 'agua', 'agua con'].map(phrase =>
    page.waitForResponse(response => searchPhrase(response.request()) === phrase),
  )
  for (const [letters, phrase] of [['ag', 'ag'], ['ua', 'agua'], [' con', 'agua con']]) {
    const request = page.waitForRequest(request => searchPhrase(request) === phrase)
    // Keyboard input intentionally does not refocus the textbox between stages.
    // A remount or lost focus would drop the remaining characters.
    await page.keyboard.type(letters!)
    await request
    await expect(search).toHaveValue(phrase!)
    await expect(search).toBeFocused()
    expect(await search.evaluate((current, original) => current === original, originalInput)).toBe(true)
    expect(Math.abs((await search.boundingBox())!.y - initialY)).toBeLessThanOrEqual(2)
    await expect(page.getByText('Actualizando productos…', { exact: true })).toBeVisible()
    await expect(cards.getByRole('heading', { name: 'Arroz largo fino', exact: true })).toBeVisible()
    await expect(page.getByText('Preparando la tienda…', { exact: true })).toHaveCount(0)
  }

  await responses[2]
  await expect(cards).toHaveCount(1)
  await expect(cards.getByRole('heading', { name: 'Agua con gas 1,5 L', exact: true })).toBeVisible()
  await Promise.all(responses)
  // Late responses for the shorter phrases must never replace the latest result.
  await expect(cards).toHaveCount(1)
  await expect(search).toHaveValue('agua con')
  await expect(search).toBeFocused()
  expect(await search.evaluate((current, original) => current === original, originalInput)).toBe(true)
  expect(Math.abs((await search.boundingBox())!.y - initialY)).toBeLessThanOrEqual(2)

  await search.press('ControlOrMeta+A')
  await search.press('Backspace')
  await expect(search).toHaveValue('')
  await expect(page).toHaveURL(new RegExp(`/t/${slug}$`))
  await expect(cards).toHaveCount(productNames.length)
  await expect(search).toBeFocused()
  expect(await search.evaluate((current, original) => current === original, originalInput)).toBe(true)
  expect(Math.abs((await search.boundingBox())!.y - initialY)).toBeLessThanOrEqual(2)
  expect(await loadingMonitor.evaluate(state => {
    state.observer?.disconnect()
    return state.flashed
  })).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a failed catalog request keeps search available and can retry without claiming an empty catalog', async ({ page }) => {
  await routePublicCatalog(page, catalog, slug, 'store')
  let fail = true
  await page.route('**/rest/v1/rpc/get_public_store_catalog_page', route => fail
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporarily unavailable' }) })
    : route.fallback())
  await page.goto(`/t/${slug}`)
  await expect(page.getByRole('textbox', { name: 'Buscar productos' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No pudimos cargar los productos' })).toBeVisible()
  await expect(page.getByText('El catálogo está en preparación', { exact: true })).toHaveCount(0)
  fail = false
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click()
  await expect(page.locator('.store-grid .store-product-card')).toHaveCount(productNames.length)
  await expect(page.getByRole('heading', { name: 'No pudimos cargar los productos' })).toHaveCount(0)
})
