import { expect, test, type Page } from '@playwright/test'

const restaurantId = '71000000-0000-4000-8000-000000000001'
const categoryId = '72000000-0000-4000-8000-000000000001'
// Keep the cover request/decoding path realistic without making a synthetic
// solid-color placeholder the LCP candidate. The product fixture remains visible.
const lightCoverImage = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"/>',
)
const lightProductImage = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><rect width="1200" height="600" fill="#f7e845"/></svg>',
)

function product(index: number) {
  const suffix = String(index + 1).padStart(12, '0')
  return {
    id: `73000000-0000-4000-8000-${suffix}`,
    categoryId,
    code: `PERF-${index + 1}`,
    name: `Producto de rendimiento ${index + 1}`,
    description: 'Descripción breve para la prueba de carga incremental.',
    basePriceCents: 100_000 + index,
    promotionalPriceCents: null,
    promotionStartsAt: null,
    promotionEndsAt: null,
    imagePath: index === 0 ? 'performance/product-1200.webp' : null,
    available: true,
    featured: index === 0,
    sortOrder: index,
    quantityPrices: [],
    optionGroups: [],
  }
}

const products = Array.from({ length: 30 }, (_, index) => product(index))
const restaurant = {
  id: restaurantId,
  name: 'Mozzi Performance',
  tradeName: 'Mozzi Performance',
  slug: 'performance-test',
  description: 'Catálogo aislado para presupuestos de rendimiento.',
  whatsappPhone: '+5493492123456',
  address: 'Calle 123',
  city: 'Rafaela',
  timezone: 'America/Argentina/Cordoba',
  currencyCode: 'ARS',
  locale: 'es-AR',
  logoPath: null,
  coverPath: 'performance/cover-1200.webp',
  primaryColor: '#412f06',
  secondaryColor: '#f7e845',
  deliveryEnabled: true,
  pickupEnabled: true,
  minimumOrderCents: 0,
  defaultPreparationMinutes: 30,
  isOpen: true,
  nextOpeningAt: null,
}
const category = {
  id: categoryId,
  name: 'Rendimiento',
  slug: 'rendimiento',
  description: '',
  imagePath: null,
  sortOrder: 0,
}
const commonMeta = {
  restaurant,
  categories: [category],
  businessHours: [],
  specialHours: [],
  paymentMethods: [],
  deliveryZones: [],
}

async function mockCatalog(page: Page) {
  let pageRequests = 0
  await page.route('https://e2e.invalid/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let body: unknown
    if (path.startsWith('/storage/v1/object/public/restaurant-assets/')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: path.includes('/cover-') ? lightCoverImage : lightProductImage,
      })
      return
    } else if (path === '/rest/v1/rpc/get_public_menu') {
      body = { ...commonMeta, categories: [{ ...category, products }] }
    } else if (path === '/rest/v1/rpc/get_public_catalog_meta') {
      body = { ...commonMeta, revision: 1 }
    } else if (path === '/rest/v1/rpc/get_public_catalog_revision') {
      body = { revision: 1, updatedAt: '2026-10-29T12:00:00Z' }
    } else if (path === '/rest/v1/rpc/get_public_catalog_page') {
      pageRequests += 1
      const input = request.postDataJSON() as { p_after_group_id?: string | null }
      const start = input.p_after_group_id ? 24 : 0
      const rows = products.slice(start, start + 24)
      body = {
        revision: 1,
        items: rows.map((variant) => ({
          id: variant.id,
          categoryId,
          family: null,
          variants: [variant],
        })),
        nextCursor: start === 0 ? products[23]!.id : null,
      }
    } else {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PGRST116', message: `Unexpected mock request: ${path}` }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return { getPageRequests: () => pageRequests }
}

test('public catalog meets mobile Web Vitals budgets under slow network and 4x CPU', async ({ page, context }, testInfo) => {
  const catalog = await mockCatalog(page)
  await page.addInitScript(() => {
    const supported = new Set(PerformanceObserver.supportedEntryTypes)
    const metrics = {
      lcp: 0,
      cls: 0,
      longestTask: 0,
      inp: 0,
      fallbackInp: 0,
      support: {
        lcp: supported.has('largest-contentful-paint'),
        cls: supported.has('layout-shift'),
        longtask: supported.has('longtask'),
        event: supported.has('event'),
      },
    }
    Object.defineProperty(window, '__mozziPerformance', { value: metrics })
    const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return
      new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({
        type,
        buffered: true,
      })
    }
    observe('largest-contentful-paint', (entry) => { metrics.lcp = entry.startTime })
    observe('layout-shift', (entry) => {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
      if (!shift.hadRecentInput) metrics.cls += shift.value
    })
    observe('longtask', (entry) => { metrics.longestTask = Math.max(metrics.longestTask, entry.duration) })
    observe('event', (entry) => {
      const event = entry as PerformanceEntry & { duration: number; interactionId?: number }
      if (event.interactionId) metrics.inp = Math.max(metrics.inp, event.duration)
    })
    // Event Timing is optional. When Chromium omits it, the next-frame delay
    // after real pointer/keyboard input remains a conservative interaction fallback.
    const recordFallbackInteraction = () => {
      const startedAt = performance.now()
      requestAnimationFrame(() => {
        metrics.fallbackInp = Math.max(metrics.fallbackInp, performance.now() - startedAt)
      })
    }
    addEventListener('pointerdown', recordFallbackInteraction, { capture: true })
    addEventListener('keydown', recordFallbackInteraction, { capture: true })
  })

  const session = await context.newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    // Constrained mobile network: 100 ms RTT, 2.5 Mbps down, 1 Mbps up.
    latency: 100,
    downloadThroughput: 312_500,
    uploadThroughput: 125_000,
    connectionType: 'cellular4g',
  })
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  await page.goto('/r/performance-test', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Mozzi Performance', level: 1 })).toBeVisible()
  await expect(page.getByText('Producto de rendimiento 1', { exact: true })).toBeVisible()
  const coverImage = page.locator('img[fetchpriority="high"]')
  await expect(coverImage).toHaveCount(1)
  await expect.poll(
    () => coverImage.evaluate((image) => image.complete && image.naturalWidth > 0),
    { message: 'La portada prioritaria debe cargar y decodificar', timeout: 5_000 },
  ).toBe(true)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  const initialHeaderBox = await page.locator('header').boundingBox()
  const initialMetrics = await page.evaluate(() => {
    const metrics = (
      window as typeof window & {
        __mozziPerformance: {
          lcp: number
          cls: number
          longestTask: number
          inp: number
          fallbackInp: number
          support: { lcp: boolean; cls: boolean; longtask: boolean; event: boolean }
        }
      }
    ).__mozziPerformance
    const snapshot = { ...metrics }
    metrics.longestTask = 0
    metrics.inp = 0
    return snapshot
  })

  const loadMore = page.getByRole('button', { name: /ver más productos/i })
  await expect(loadMore).toBeVisible()
  expect(catalog.getPageRequests()).toBe(1)
  await loadMore.click()
  await expect(page.getByText('Producto de rendimiento 24', { exact: true })).toBeVisible()
  expect(catalog.getPageRequests()).toBe(1)
  await loadMore.click()
  await expect(page.getByText('Producto de rendimiento 30', { exact: true })).toBeVisible()
  expect(catalog.getPageRequests()).toBe(2)

  const search = page.getByRole('textbox', { name: /buscar/i })
  await search.click()
  await search.fill('Producto')
  await page.waitForTimeout(500)

  await page.waitForTimeout(500)
  const metrics = await page.evaluate(() => (
    window as typeof window & {
      __mozziPerformance: {
        lcp: number
        cls: number
        longestTask: number
        inp: number
        fallbackInp: number
        support: { lcp: boolean; cls: boolean; longtask: boolean; event: boolean }
      }
    }
  ).__mozziPerformance)
  const finalHeaderBox = await page.locator('header').boundingBox()
  // LayoutShift is not exposed by every browser build. Header geometry is a
  // documented stability proxy; the attached JSON records which source won.
  const fallbackCls = initialHeaderBox && finalHeaderBox
    ? Math.max(
        Math.abs(finalHeaderBox.x - initialHeaderBox.x) / 390,
        Math.abs(finalHeaderBox.y - initialHeaderBox.y) / 844,
        Math.abs(finalHeaderBox.width - initialHeaderBox.width) / 390,
        Math.abs(finalHeaderBox.height - initialHeaderBox.height) / 844,
      )
    : 1
  await testInfo.attach('performance-metrics.json', {
    body: JSON.stringify({
      initial: initialMetrics,
      interactions: metrics,
      resolved: {
        cls: initialMetrics.support.cls ? metrics.cls : fallbackCls,
        clsSource: initialMetrics.support.cls ? 'layout-shift' : 'header-geometry-fallback',
        inp: initialMetrics.support.event && metrics.inp > 0 ? metrics.inp : metrics.fallbackInp,
        inpSource: initialMetrics.support.event && metrics.inp > 0 ? 'event-timing' : 'next-frame-fallback',
      },
    }, null, 2),
    contentType: 'application/json',
  })

  expect(initialMetrics.support.lcp, 'Soporte de Largest Contentful Paint').toBe(true)
  expect(initialMetrics.support.longtask, 'Soporte de Long Tasks').toBe(true)
  expect(initialMetrics.lcp, 'LCP móvil').toBeGreaterThan(0)
  expect(initialMetrics.lcp, 'LCP móvil').toBeLessThanOrEqual(2_500)
  expect(initialMetrics.longestTask, 'Long task inicial más largo').toBeLessThanOrEqual(200)
  expect(metrics.longestTask, 'Long task de interacción más largo').toBeLessThanOrEqual(200)
  if (initialMetrics.support.cls) expect(metrics.cls, 'CLS móvil').toBeLessThanOrEqual(0.1)
  else expect(fallbackCls, 'Fallback de estabilidad del encabezado').toBeLessThanOrEqual(0.1)
  if (initialMetrics.support.event && metrics.inp > 0) {
    expect(metrics.inp, 'INP observado').toBeLessThanOrEqual(200)
  } else {
    expect(metrics.fallbackInp, 'Fallback de interacción observado').toBeGreaterThan(0)
    expect(metrics.fallbackInp, 'Fallback de interacción observado').toBeLessThanOrEqual(200)
  }
})
