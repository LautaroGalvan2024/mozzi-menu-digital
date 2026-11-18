import { expect, test, type Locator, type Page } from '@playwright/test'
import { routePublicCatalog } from './public-catalog-fixture'

const slug = 'almacen-imagenes'
const categoryId = '62000000-0000-4000-8000-000000000001'
const catalogPath = `/t/${slug}?category=${categoryId}`

const products = [
  { name: 'Agua mineral 2 L', imagePath: 'products/image-review/tall.webp', price: 90000 },
  { name: 'Galletitas de avena', imagePath: 'products/image-review/wide.webp', price: 145000 },
  { name: 'Yerba mate 500 g', imagePath: 'products/image-review/square.webp', price: 320000 },
  { name: 'Aceite de girasol', imagePath: 'products/image-review/broken.webp', price: 270000 },
  { name: 'Azúcar 1 kg', imagePath: null, price: 110000 },
].map((product, index) => ({
  id: `64000000-0000-4000-8000-00000000000${index + 1}`,
  categoryId,
  code: `FOTO-${index + 1}`,
  name: product.name,
  description: 'Un producto para tu compra de todos los días.',
  basePriceCents: product.price,
  promotionalPriceCents: null,
  promotionStartsAt: null,
  promotionEndsAt: null,
  imagePath: product.imagePath,
  available: true,
  featured: false,
  sortOrder: index,
  quantityPrices: [],
  quantityThreshold: index === 0 ? { minimumQuantity: 6, unitPriceCents: 80000 } : null,
  optionGroups: [],
  family: null,
  variantAttributes: {},
}))

const catalog = {
  restaurant: {
    id: '61000000-0000-4000-8000-000000000001',
    name: 'Almacén del barrio', tradeName: 'Almacén del barrio', slug,
    description: 'Todo para tu compra, en un solo lugar.',
    whatsappPhone: '+5493492123456', address: 'San Martín 123', city: 'Rafaela',
    timezone: 'America/Argentina/Cordoba', currencyCode: 'ARS', locale: 'es-AR',
    logoPath: null, coverPath: null, primaryColor: '#4338ca', secondaryColor: '#e0e7ff',
    deliveryEnabled: true, pickupEnabled: true, minimumOrderCents: 0,
    defaultPreparationMinutes: 30, isOpen: true, acceptsOrders: true, nextOpeningAt: null,
    channel: 'store', storeCheckoutWhatsappEnabled: true, storeCheckoutOnlineEnabled: false,
  },
  categories: [
    { id: categoryId, name: 'Almacén', slug: 'almacen', description: '', imagePath: null, sortOrder: 0, products },
    ...['Bebidas', 'Bebidas alcohólicas', 'Higiene personal', 'Limpieza', 'Bazar', 'Alimentos para animales', 'Infusiones', 'Lácteos', 'Condimentos'].map((name, index) => ({
      id: `62000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
      name, slug: `categoria-${index}`, description: '', imagePath: null, sortOrder: index + 1, products: [],
    })),
  ],
  businessHours: [], specialHours: [], deliveryZones: [], paymentMethods: [],
}

// Deliberately different intrinsic proportions reproduce the original tall-image
// grid overflow. Both the cap and base must remain inside the image stage.
const images: Record<string, string> = {
  'tall.webp': `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="1000" viewBox="0 0 240 1000">
    <defs><linearGradient id="water"><stop stop-color="#c5e2e5"/><stop offset=".42" stop-color="#f7fcfd"/><stop offset="1" stop-color="#a5cdd2"/></linearGradient></defs>
    <rect width="240" height="1000" fill="white"/>
    <path d="M83 80H157V185C157 245 216 286 216 365V929Q216 980 174 980H66Q24 980 24 929V365C24 286 83 245 83 185Z" fill="url(#water)" stroke="#a1c3c8" stroke-width="4"/>
    <rect x="76" y="20" width="88" height="78" rx="14" fill="#18865c"/>
    <path d="M91 32V82M106 32V82M122 32V82M138 32V82M153 32V82" stroke="#56b18b" stroke-width="5"/>
    <rect x="26" y="444" width="188" height="260" rx="8" fill="#e8f4ef"/>
    <path d="M26 500Q80 460 122 510T214 500V570H26Z" fill="#278d71"/>
    <text x="120" y="620" fill="#14644f" font-family="sans-serif" font-size="30" text-anchor="middle" font-weight="700">MINERAL</text>
    <text x="120" y="666" fill="#14644f" font-family="sans-serif" font-size="24" text-anchor="middle">2 L</text>
    <path d="M45 810H195M45 852H195M45 894H195" stroke="#a8cbd0" stroke-width="7"/>
  </svg>`,
  'wide.webp': `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="280" viewBox="0 0 1200 280">
    <rect width="1200" height="280" fill="white"/><path d="M20 25H1180L1160 140L1180 255H20L40 140Z" fill="#d99b42"/>
    <path d="M55 30V250M1145 30V250" stroke="#b87b29" stroke-width="13"/>
    <rect x="110" y="42" width="980" height="196" rx="26" fill="#f9edcf"/>
    <text x="600" y="130" text-anchor="middle" fill="#795128" font-family="sans-serif" font-weight="700" font-size="66">GALLETITAS DE AVENA</text>
    <text x="600" y="195" text-anchor="middle" fill="#795128" font-family="sans-serif" font-size="38">Clásicas · 300 g</text>
  </svg>`,
  'square.webp': `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700" viewBox="0 0 700 700">
    <rect width="700" height="700" fill="white"/><path d="M130 35H570L590 665H110Z" fill="#247458"/>
    <path d="M145 62H555M130 635H570" stroke="#7db092" stroke-width="15"/>
    <rect x="130" y="215" width="440" height="260" rx="6" fill="#fff1d3"/>
    <text x="350" y="315" text-anchor="middle" fill="#24684c" font-family="sans-serif" font-weight="700" font-size="62">YERBA MATE</text>
    <text x="350" y="402" text-anchor="middle" fill="#24684c" font-family="sans-serif" font-size="42">Tradicional</text>
    <text x="350" y="560" text-anchor="middle" fill="white" font-family="sans-serif" font-size="40">500 g</text>
  </svg>`,
}

async function expectImageInsideStage(stage: Locator, image: Locator) {
  await image.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate(element => {
    const image = element as HTMLImageElement
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
  })).toBe(true)
  const stageBox = await stage.boundingBox()
  const imageBox = await image.boundingBox()
  expect(stageBox).not.toBeNull()
  expect(imageBox).not.toBeNull()
  expect(imageBox!.width).toBeGreaterThan(0)
  expect(imageBox!.height).toBeGreaterThan(0)
  expect(imageBox!.x).toBeGreaterThanOrEqual(stageBox!.x - 1)
  expect(imageBox!.y).toBeGreaterThanOrEqual(stageBox!.y - 1)
  expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width + 1)
  expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(stageBox!.y + stageBox!.height + 1)
  expect(['contain', 'scale-down']).toContain(await image.evaluate(element => getComputedStyle(element).objectFit))
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('store contains tall, wide and square photos at every viewport and keeps unavailable photos purchasable', async ({ page }, testInfo) => {
  await routePublicCatalog(page, catalog, slug, 'store')
  await page.route('https://e2e.invalid/storage/**', route => {
    const filename = new URL(route.request().url()).pathname.split('/').at(-1) ?? ''
    const image = images[filename]
    return image
      ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: image })
      : route.fulfill({ status: 404, body: '' })
  })

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(catalogPath)
    const cards = page.locator('.store-grid .store-product-card')
    await expect(cards).toHaveCount(products.length)
    for (const product of products.slice(0, 3)) {
      const card = cards.filter({ has: page.getByRole('heading', { name: product.name, exact: true }) })
      await expectImageInsideStage(card.locator('.store-card-image'), card.locator('.store-card-image img'))
    }
    const broken = cards.filter({ hasText: 'Aceite de girasol' })
    const missing = cards.filter({ hasText: 'Azúcar 1 kg' })
    await broken.scrollIntoViewIfNeeded()
    await expect(broken.getByRole('img', { name: 'Foto no disponible' })).toBeVisible()
    await expect(missing.getByRole('img', { name: 'Producto sin foto' })).toBeVisible()
    await expect(broken.getByRole('button', { name: 'Agregar', exact: true })).toBeEnabled()
    await expect(missing.getByRole('button', { name: 'Agregar', exact: true })).toBeEnabled()
    await expectNoHorizontalOverflow(page)
    if (width === 390) {
      await page.getByRole('button', { name: 'Ver más categorías', exact: true }).click()
      await expect.poll(() => page.getByRole('navigation', { name: 'Filtrar por categoría' }).evaluate(nav => nav.scrollLeft)).toBeGreaterThan(0)
      await page.getByRole('button', { name: 'Ver categorías anteriores', exact: true }).click()
      await expect.poll(() => page.getByRole('navigation', { name: 'Filtrar por categoría' }).evaluate(nav => nav.scrollLeft)).toBeLessThanOrEqual(2)
    }
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }) })
    await page.screenshot({ path: testInfo.outputPath(`store-image-catalog-${width}.png`), fullPage: true })

    for (const product of products.slice(0, 3)) {
      await page.getByRole('link', { name: `Ver ${product.name}`, exact: true }).click()
      await expect(page.getByRole('heading', { name: product.name, level: 1 })).toBeVisible()
      await expectImageInsideStage(page.locator('.store-detail-image'), page.locator('.store-detail-image-button img'))
      await expectNoHorizontalOverflow(page)
      if (product === products[0]) {
        await page.screenshot({ path: testInfo.outputPath(`store-image-detail-${width}.png`), fullPage: true })
        await page.locator('.store-notes-disclosure summary').click()
        await page.getByRole('textbox', { name: '¿Querés aclarar algo?' }).fill('Retiro por la tarde')
        await expect(page.getByRole('textbox', { name: '¿Querés aclarar algo?' })).toHaveValue('Retiro por la tarde')
        await page.locator('.store-notes-disclosure summary').click()
        const zoom = page.getByRole('button', { name: `Ampliar foto de ${product.name}` })
        await zoom.click()
        await expect(page.getByRole('dialog', { name: `Foto ampliada de ${product.name}` })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(zoom).toBeFocused()
      }
      await page.getByRole('link', { name: 'Volver a productos', exact: true }).click()
      await expect(cards).toHaveCount(products.length)
    }
  }

  // A failed photo never prevents ordering. Follow the same fallback into detail,
  // add the product, and verify the cart retained the selected product.
  await page.getByRole('link', { name: 'Ver Aceite de girasol', exact: true }).click()
  await expect(page.locator('.store-detail-image').getByRole('img', { name: 'Foto no disponible' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Ampliar foto/ })).toHaveCount(0)
  await page.getByRole('button', { name: /Agregar al carrito/ }).click()
  await page.getByRole('link', { name: /Ver carrito · 1/ }).click()
  await expect(page.getByRole('heading', { name: 'Tu carrito', level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Productos en el carrito' }).getByRole('article', { name: 'Aceite de girasol' })).toBeVisible()
})
