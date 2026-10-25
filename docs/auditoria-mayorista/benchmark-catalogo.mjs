// Auditoría: usa el build local, intercepta toda salida de red y nunca crea pedidos.
// Terminal 1: npm run build; npm run preview -- --host 127.0.0.1 --port 4175 --strictPort
// Terminal 2: node docs/auditoria-mayorista/benchmark-catalogo.mjs
import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import os from 'node:os'

const base = 'http://127.0.0.1:4175'
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function menu(size, rules, images) {
  const categories = Array.from({ length: 20 }, (_, i) => ({
    id: uuid(100000 + i), name: `Categoría ${i + 1}`, slug: `categoria-${i + 1}`,
    description: '', imagePath: null, sortOrder: i, products: [],
  }))
  for (let i = 0; i < size; i++) {
    const category = categories[i % categories.length]
    category.products.push({
      id: uuid(i + 1), categoryId: category.id, code: `SKU-${String(i + 1).padStart(6, '0')}`,
      name: `Producto sintético ${i + 1}`, description: 'Descripción sintética de artículo mayorista para evaluar búsqueda y renderizado.',
      basePriceCents: 100000, promotionalPriceCents: null, promotionStartsAt: null, promotionEndsAt: null,
      imagePath: images ? `${uuid(900000)}/audit-${i + 1}.webp` : null,
      available: true, featured: false, sortOrder: i,
      quantityPrices: Array.from({ length: rules }, (_, j) => ({ quantity: j + 2, totalPriceCents: (j + 2) * 90000 })),
      optionGroups: [],
    })
  }
  return { restaurant: {
    id: uuid(900000), name: 'Auditoría sintética', tradeName: 'Auditoría sintética', slug: 'audit-benchmark',
    description: '', whatsappPhone: '+5491100000000', address: 'Dirección sintética', city: 'Ciudad sintética',
    timezone: 'America/Argentina/Buenos_Aires', currencyCode: 'ARS', locale: 'es-AR',
    logoPath: null, coverPath: null, primaryColor: '#ea580c', secondaryColor: '#1c1917',
    deliveryEnabled: false, pickupEnabled: true, minimumOrderCents: 0, defaultPreparationMinutes: 30,
    isOpen: true, nextOpeningAt: null,
  }, categories, businessHours: [], specialHours: [], paymentMethods: [], deliveryZones: [] }
}

const browser = await chromium.launch()
const generator = await browser.newPage()
const imageBase64 = await generator.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 600
  const ctx = canvas.getContext('2d'); const data = ctx.createImageData(600, 600)
  let seed = 12345
  for (let i = 0; i < data.data.length; i += 4) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    data.data[i] = seed & 255; data.data[i + 1] = (seed >>> 8) & 255; data.data[i + 2] = (seed >>> 16) & 255; data.data[i + 3] = 255
  }
  ctx.putImageData(data, 0, 0)
  return canvas.toDataURL('image/webp', 0.7).split(',')[1]
})
const picture = Buffer.from(imageBase64, 'base64')
await generator.close()
const startedAt = new Date().toISOString()
const results = []
try {
  for (const size of [500, 1500, 5000]) {
    for (const mode of ['desktop', 'mobile', 'mobile-promos']) {
      const mobile = mode !== 'desktop', rules = mode === 'mobile-promos' ? 19 : 0
      const body = JSON.stringify(menu(size, rules, mobile))
      for (let repetition = 1; repetition <= 3; repetition++) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, serviceWorkers: 'block' })
        const page = await context.newPage()
        const cdp = await context.newCDPSession(page)
        await cdp.send('Performance.enable')
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: mobile ? 4 : 1 })
        let rpcCount = 0, imageCount = 0, mockBytes = 0
        const blocked = [], errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(() => {
          window.__auditLongTasks = []
          new PerformanceObserver(list => window.__auditLongTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true })
        })
        await context.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (url.pathname === '/rest/v1/rpc/get_public_menu') {
            rpcCount++; mockBytes += Buffer.byteLength(body)
            // Demora sintética de metadata: RTT 80ms + cuerpo SIN gzip / 0.5 MB/s.
            // No es un emulador de ancho de banda compartido ni una latencia de Supabase.
            if (mobile) await sleep(80 + Buffer.byteLength(body) / 500)
            return route.fulfill({ status: 200, contentType: 'application/json', body })
          }
          if (url.pathname.includes('/storage/v1/object/public/restaurant-assets/')) {
            imageCount++; mockBytes += picture.length
            if (mobile) await sleep(80 + picture.length / 500)
            return route.fulfill({ status: 200, contentType: 'image/webp', body: picture })
          }
          if (url.origin === base) return route.continue()
          blocked.push(url.origin + url.pathname)
          return route.abort()
        })
        const start = performance.now()
        await page.goto(`${base}/r/audit-benchmark`)
        await page.waitForFunction(n => document.querySelectorAll('main article').length === n, size, { timeout: 90000 })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const readyMs = performance.now() - start
        await sleep(700)
        const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
        const snapshot = await page.evaluate(() => ({ nodes: document.querySelectorAll('*').length, articles: document.querySelectorAll('main article').length, longTasks: window.__auditLongTasks, resourceBytes: performance.getEntriesByType('resource').reduce((a, e) => a + e.transferSize, 0) }))
        const initialImageCount = imageCount
        const searchStart = performance.now()
        await page.getByRole('textbox', { name: 'Buscar en el menú' }).fill(`SKU-${String(size).padStart(6, '0')}`)
        await page.waitForFunction(() => document.querySelectorAll('main article').length === 1)
        const searchMs = performance.now() - searchStart
        const result = { size, mode, rulesPerProduct: rules, repetition, concurrency: 1, readyMs: Math.round(readyMs), searchMs: Math.round(searchMs), jsonBytes: Buffer.byteLength(body), jsonGzipBytes: gzipSync(body).length, syntheticImageBytes: mobile ? picture.length : 0, initialImageCount, rpcCount, mockBodyBytes: mockBytes, nodes: snapshot.nodes, articles: snapshot.articles, heapBytes: metrics.JSHeapUsedSize, longTaskCount: snapshot.longTasks.length, maxLongTaskMs: Math.round(Math.max(0, ...snapshot.longTasks)), resourceTransferBytes: snapshot.resourceBytes, errors, blockedRequests: blocked }
        results.push(result)
        console.log(JSON.stringify(result))
        await context.close()
      }
    }
  }
} finally {
  const report = { startedAt, finishedAt: new Date().toISOString(), node: process.version, chromium: browser.version(), platform: os.platform(), cpu: os.cpus()[0].model, memoryBytes: os.totalmem(), notes: 'RPC e imágenes sintéticas; ninguna llamada externa. No mide DB, RLS, Realtime, historial ni concurrencia servidor. CPU 4x no equivale a celular real. Demoras por respuesta independientes, sin límite de ancho de banda compartido. resourceTransferBytes excluye cuerpos mock; mockBodyBytes incluye solicitudes disparadas, no garantiza bytes finales en red. Imagen sintética 600x600.', results }
  await writeFile(new URL('./benchmark-resultados.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
  await browser.close()
}
