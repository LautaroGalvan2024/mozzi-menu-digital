import { createHmac } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { rehearsalEnvironment, rehearsalFixtures as fixture } from './self-host-rehearsal-env'

type RehearsalEnvironment = ReturnType<typeof rehearsalEnvironment>
type Session = { access_token?: string; user?: { email?: string } }
type PublicCatalog = {
  restaurant?: { slug?: string; id?: string; logoPath?: string | null; coverPath?: string | null }
  categories?: Array<{
    imagePath?: string | null
    products?: Array<{ imagePath?: string | null; family?: { imagePath?: string | null } }>
  }>
}

function rehearsalHeaders(env: RehearsalEnvironment, token?: string) {
  return {
    apikey: env.publishableKey,
    Origin: env.web.origin,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function atPath(response: Response, origin: string, path: string, method: string) {
  const url = new URL(response.url())
  return url.origin === origin && url.pathname === path && response.request().method() === method
}

async function login(page: Page, env: RehearsalEnvironment, actor: RehearsalEnvironment['operator'], destination: string) {
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`)
  await page.getByLabel('Correo').fill(actor.email)
  await page.getByLabel('Contraseña').fill(actor.password)
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => atPath(candidate, env.api.origin, '/auth/v1/token', 'POST')),
    page.getByRole('button', { name: 'Ingresar' }).click(),
  ])
  expect(response.status(), 'local Auth accepted the synthetic user').toBe(200)
  const session = await response.json() as Session
  if (!session.access_token || session.user?.email !== actor.email) {
    throw new Error('Supabase did not return the expected synthetic session')
  }
  return session.access_token
}

async function readCatalog(request: APIRequestContext, env: RehearsalEnvironment, slug: string, channel: 'menu' | 'store') {
  const route = channel === 'menu' ? 'get_public_menu' : 'get_public_catalog'
  const result = await request.post(new URL(`/rest/v1/rpc/${route}`, env.api).href, {
    headers: rehearsalHeaders(env),
    data: { p_restaurant_slug: slug, ...(channel === 'store' ? { p_channel: 'store' } : {}) },
    maxRedirects: 0,
  })
  expect(result.status(), 'public catalog RPC status').toBe(200)
  const catalog = await result.json() as PublicCatalog | null
  if (catalog?.restaurant?.slug !== slug || !catalog.categories?.some((category) => category.products?.length)) {
    throw new Error('The requested catalog is missing, unpublished, or empty')
  }
  return catalog
}

function catalogImagePath(catalog: PublicCatalog) {
  const paths = catalog.categories?.flatMap((category) =>
    category.products?.flatMap((product) => [product.imagePath, product.family?.imagePath]) ?? [],
  ) ?? []
  const path = [...paths, catalog.restaurant?.coverPath, catalog.restaurant?.logoPath]
    .find((entry): entry is string => Boolean(entry))
  if (!path || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('No safe relative image path was published for the restored catalog')
  }
  return path.split('/').map(encodeURIComponent).join('/')
}

function totpCode(secret: string, timestamp: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const key: number[] = []
  for (const character of secret.toUpperCase().replace(/\s|=/g, '')) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error('Unexpected format for the isolated TOTP enrollment')
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      key.push((value >> (bits - 8)) & 255)
      bits -= 8
    }
  }
  if (!key.length) throw new Error('The isolated TOTP enrollment has no secret')
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)))
  const digest = createHmac('sha1', Buffer.from(key)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 15
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, '0')
}

async function checkRealtimeSubscription(env: RehearsalEnvironment, token: string) {
  const client = createClient(env.api.origin, env.publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  })
  await client.realtime.setAuth(token)
  const filter = `restaurant_id=eq.${fixture.restaurantId}`
  const channel = client.channel('mozzi-rehearsal-order-publications')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter }, () => {})
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_events', filter }, () => {})
  try {
    const status = await new Promise<string>((resolve) => {
      const limit = setTimeout(() => resolve('NO_REPLY'), 12_000)
      channel.subscribe((state) => {
        clearTimeout(limit)
        resolve(state)
      }, 10_000)
    })
    expect(status, 'authenticated Realtime joins both order publications').toBe('SUBSCRIBED')
  } finally {
    await client.removeChannel(channel)
  }
}

let env: RehearsalEnvironment

test.describe('isolated Supabase rehearsal', () => {
  test.skip(process.env.MOZZI_REHEARSAL_E2E !== '1', 'Run only with the isolated rehearsal config')
  test.beforeEach(async ({ context }, testInfo) => {
    if (!testInfo.config.configFile?.endsWith('playwright.self-host-rehearsal.config.ts')) {
      throw new Error('Run the isolated suite with its own localhost config')
    }
    env = rehearsalEnvironment()
    const origins = new Set([env.api.origin, env.web.origin])
    await context.route(/^https?:\/\//, async (route) => {
      if (origins.has(new URL(route.request().url()).origin)) await route.continue()
      else await route.abort()
    })
    await context.routeWebSocket(/^wss?:\/\//, (socket) => {
      const upstream = new URL(socket.url())
      upstream.protocol = upstream.protocol === 'wss:' ? 'https:' : 'http:'
      if (origins.has(upstream.origin)) socket.connectToServer()
      else socket.close()
    })
  })

  for (const channel of ['menu', 'store'] as const) {
    test(`restored ${channel} reads its persisted catalog and image`, async ({ page, request }) => {
      const slug = channel === 'menu' ? env.restoredMenuSlug : env.restoredStoreSlug
      const catalog = await readCatalog(request, env, slug, channel)
      expect(catalog.restaurant?.id !== fixture.restaurantId && catalog.restaurant?.id !== fixture.otherRestaurantId).toBe(true)

      const objectPath = catalogImagePath(catalog)
      const objectUrl = new URL(`/storage/v1/object/public/restaurant-assets/${objectPath}`, env.api)
      const image = await request.get(objectUrl.href, { headers: rehearsalHeaders(env), maxRedirects: 0 })
      expect(image.status(), 'restored Storage image status').toBe(200)
      expect(Boolean(image.headers()['content-type']?.startsWith('image/')), 'restored image media type').toBe(true)
      expect((await image.body()).byteLength > 0, 'nonempty restored image payload').toBe(true)

      const [, response] = await Promise.all([
        page.goto(`/${channel === 'menu' ? 'r' : 't'}/${slug}`),
        page.waitForResponse((candidate) =>
          atPath(candidate, env.api.origin, '/rest/v1/rpc/get_public_catalog_meta', 'POST'),
        ),
      ])
      expect(response.status(), 'browser catalog metadata status').toBe(200)
      await expect(page.locator(channel === 'menu' ? 'main article' : 'main .store-card-media-link').first()).toBeVisible()
      const imageDecoded = await page.evaluate(async (source) => {
        const restoredImage = new Image()
        restoredImage.src = source
        try {
          await restoredImage.decode()
          return restoredImage.naturalWidth > 0 && restoredImage.naturalHeight > 0
        } catch {
          return false
        }
      }, objectUrl.href)
      expect(imageDecoded, 'Chromium decodes the restored Storage object').toBe(true)
    })
  }

  test('operator logs in, reads own tenant, subscribes to Realtime, and gets sandbox-only payment status', async ({ page, request }) => {
    const token = await login(page, env, env.operator, '/admin/pedidos')
    await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()

    const tables = new URL('/rest/v1/restaurants', env.api)
    tables.searchParams.set('id', `in.(${fixture.restaurantId},${fixture.otherRestaurantId})`)
    tables.searchParams.set('select', 'id')
    const allowed = await request.get(tables.href, { headers: rehearsalHeaders(env, token), maxRedirects: 0 })
    expect(allowed.status(), 'authenticated RLS query status').toBe(200)
    const ownRows = await allowed.json() as Array<{ id?: string }>
    expect(ownRows.length === 1 && ownRows[0]?.id === fixture.restaurantId, 'tenant isolation').toBe(true)

    const anonymousOrdersUrl = new URL('/rest/v1/orders?select=id&limit=1', env.api)
    const anonymous = await request.get(anonymousOrdersUrl.href, { headers: rehearsalHeaders(env), maxRedirects: 0 })
    expect([401, 403]).toContain(anonymous.status())

    const paymentUrl = new URL('/functions/v1/mercadopago-connect', env.api)
    const payment = await request.post(paymentUrl.href, {
      headers: rehearsalHeaders(env, token),
      data: { action: 'status', restaurantId: fixture.restaurantId },
      maxRedirects: 0,
    })
    expect(payment.status(), 'isolated Mercado Pago status response').toBe(200)
    const paymentStatus = await payment.json() as { environment?: string; readyForPayments?: boolean }
    expect(paymentStatus.environment === 'test' && paymentStatus.readyForPayments === false).toBe(true)
    await checkRealtimeSubscription(env, token)
  })

  test('superadmin reaches real AAL2 by enrolling and verifying a TOTP factor', async ({ page, request }) => {
    await login(page, env, env.superadmin, '/superadmin/seguridad')
    await expect(page).toHaveURL(/\/auth\/mfa/)
    await expect(page.getByRole('heading', { name: 'Activá la protección MFA' })).toBeVisible()
    await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible()
    const secret = (await page.locator('main code').textContent())?.trim()
    if (!secret) throw new Error('A fresh synthetic superadmin with an unverified TOTP factor is required')
    const remaining = 30_000 - (Date.now() % 30_000)
    if (remaining < 4_000) await new Promise((resolve) => setTimeout(resolve, remaining + 250))
    await page.getByLabel('Código TOTP').fill(totpCode(secret, Date.now()))
    const [verified] = await Promise.all([
      page.waitForResponse((response) => {
        const { origin, pathname } = new URL(response.url())
        return origin === env.api.origin && /^\/auth\/v1\/factors\/[a-f0-9-]+\/verify$/.test(pathname)
          && response.request().method() === 'POST'
      }),
      page.getByRole('button', { name: 'Verificar y continuar' }).click(),
    ])
    expect(verified.status(), 'real local GoTrue TOTP verification').toBe(200)
    const factorId = new URL(verified.url()).pathname.split('/')[4]
    const session = await verified.json() as Session
    if (!factorId || !session.access_token) throw new Error('Verified factor and AAL2 session required')
    try {
      await expect(page.getByRole('heading', { name: 'Seguridad de Super Admin' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Sesión verificada' })).toBeVisible()
      const actor = await request.post(new URL('/rest/v1/rpc/get_actor_authorization', env.api).href, {
        headers: rehearsalHeaders(env, session.access_token),
        data: {},
        maxRedirects: 0,
      })
      expect(actor.status()).toBe(200)
      const access = await actor.json() as { isSuperAdmin?: boolean; aal?: string }
      expect(access.isSuperAdmin === true && access.aal === 'aal2').toBe(true)
    } finally {
      const cleanup = await request.delete(new URL(`/auth/v1/factors/${factorId}`, env.api).href, {
        headers: rehearsalHeaders(env, session.access_token),
        maxRedirects: 0,
      })
      expect(cleanup.ok(), 'remove the synthetic enrollment after verification').toBe(true)
    }
  })

  test('checkout persists and recovers a synthetic WhatsApp order without sending it', async ({ page, request }) => {
    const catalog = await readCatalog(request, env, fixture.slug, 'menu')
    expect(catalog.restaurant?.id === fixture.restaurantId, 'only the designated synthetic tenant can receive an order').toBe(true)

    await page.goto(`/r/${fixture.slug}`)
    await page.getByRole('button', { name: new RegExp(fixture.productName) }).click()
    await page.getByRole('button', { name: /Agregar ·/ }).click()
    await page.getByRole('link', { name: /Ver carrito/ }).click()
    await page.getByRole('link', { name: 'Continuar' }).click()
    await page.getByLabel('Nombre y apellido').fill(fixture.customerName)
    await page.getByLabel('Teléfono').fill(fixture.customerPhone)
    // Checkout rejects form submissions younger than one second.
    await page.waitForTimeout(1_100)
    const [created] = await Promise.all([
      page.waitForResponse((response) => atPath(response, env.api.origin, '/functions/v1/create-order', 'POST')),
      page.getByRole('button', { name: 'Generar pedido' }).click(),
    ])
    expect([200, 201]).toContain(created.status())
    const payload = await created.json() as {
      order?: { displayNumber?: string; actionId?: string }
      whatsapp?: { url?: string; phone?: string }
    }
    const displayNumber = payload.order?.displayNumber
    if (!displayNumber || !payload.order?.actionId) throw new Error('Synthetic order reference missing')
    const link = new URL(payload.whatsapp?.url ?? 'https://invalid.invalid')
    expect(link.origin === 'https://wa.me' && link.pathname === `/${fixture.storePhone.slice(1)}`
      && payload.whatsapp?.phone === fixture.storePhone && link.searchParams.has('text')).toBe(true)
    await expect(page.getByRole('heading', { name: displayNumber })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir WhatsApp', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Quitar acceso guardado/ })).toBeVisible()

    const [, recovered] = await Promise.all([
      page.goto(`/r/${fixture.slug}/pedido-generado`),
      page.waitForResponse((response) => atPath(response, env.api.origin, '/functions/v1/recover-order', 'POST')),
    ])
    expect(recovered.status()).toBe(200)
    const confirmation = await recovered.json() as { order?: { actionId?: string; displayNumber?: string } }
    expect(confirmation.order?.actionId === payload.order.actionId && confirmation.order?.displayNumber === displayNumber).toBe(true)
    await expect(page.getByText('Pedido recuperado')).toBeVisible()
    await expect(page.getByRole('heading', { name: displayNumber })).toBeVisible()

    const token = await login(page, env, env.operator, '/admin/pedidos')
    await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()
    const stored = new URL('/rest/v1/orders', env.api)
    stored.searchParams.set('select', 'restaurant_id,display_number,status')
    stored.searchParams.set('action_id', `eq.${payload.order.actionId}`)
    const order = await request.get(stored.href, { headers: rehearsalHeaders(env, token), maxRedirects: 0 })
    expect(order.status()).toBe(200)
    const rows = await order.json() as Array<{ restaurant_id?: string; display_number?: string; status?: string }>
    expect(rows.length === 1 && rows[0]?.restaurant_id === fixture.restaurantId
      && rows[0].display_number === displayNumber && rows[0].status === 'generated').toBe(true)
  })
})
