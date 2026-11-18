import { createHash } from 'node:crypto'
import type { APIRequestContext, Page, Response } from '@playwright/test'
import { z } from 'zod'
import { generatedOrderSchema } from '../src/lib/validation/schemas'
import { expect, test } from './staging-fixtures'

const live = process.env.E2E_LIVE === '1'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

function required(name: string): string {
  const value = name === 'E2E_ADMIN_PASSWORD' ? process.env[name] : process.env[name]?.trim()
  if (!value) throw new Error(`Connected acceptance requires ${name}; missing fixtures must not pass as skipped tests.`)
  return value
}

function apiResponse(response: Response, pathname: string): boolean {
  const url = new URL(response.url())
  return url.origin === new URL(required('E2E_SUPABASE_URL')).origin && url.pathname === pathname
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected acceptance API response shape')
  return value as Record<string, unknown>
}

async function reachCheckout(page: Page) {
  const slug = required('E2E_RESTAURANT_SLUG')
  const productName = required('E2E_PRODUCT_NAME')
  const metaResponse = page.waitForResponse(response => apiResponse(response, '/rest/v1/rpc/get_public_catalog_meta'))
  await page.goto(`/r/${encodeURIComponent(slug)}`)
  const meta = await metaResponse
  expect(meta.status(), 'Published catalog metadata must come from the selected backend').toBe(200)
  const restaurant = object(object(await meta.json()).restaurant)
  expect(restaurant.slug === slug && restaurant.isOpen === true, 'Fixture restaurant must be published and open').toBe(true)
  await expect(page.getByText('Abierto ahora', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Buscar en el menú' }).fill(productName)
  const product = page.getByRole('article').filter({ has: page.getByRole('heading', { name: productName, exact: true }) })
  await expect(product).toHaveCount(1)
  await expect(product.getByRole('button')).toBeEnabled()
  await product.getByRole('button').click()
  const dialog = page.getByRole('dialog', { name: productName, exact: true })
  await expect(dialog).toBeVisible()
  // One simple fixture product, without required options or variants.
  await dialog.getByRole('button', { name: /^Agregar · / }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('link', { name: /ver carrito/i }).click()
  await expect(page.getByRole('heading', { name: 'Tu pedido', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Continuar', exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname === `/r/${slug}/checkout`)
  await expect(page.getByRole('heading', { name: 'Finalizar pedido', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Retiro/ })).toBeChecked()
  await expect(page.locator('input[name="paymentMethodId"]:checked')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Generar pedido', exact: true })).toBeEnabled()
}

interface OperatorSession {
  headers: Record<string, string>
  restaurantId: string
}

async function loginOperator(page: Page): Promise<OperatorSession> {
  await page.goto('/login?returnTo=%2Fadmin%2Fpedidos')
  await page.getByLabel('Correo', { exact: true }).fill(required('E2E_ADMIN_EMAIL'))
  await page.getByLabel('Contraseña', { exact: true }).fill(required('E2E_ADMIN_PASSWORD'))
  const tokenResponse = page.waitForResponse(response => apiResponse(response, '/auth/v1/token')
    && response.request().method() === 'POST' && new URL(response.url()).searchParams.get('grant_type') === 'password')
  const authorizationResponse = page.waitForResponse(response => apiResponse(response, '/rest/v1/rpc/get_actor_authorization'))
  const membershipsResponse = page.waitForResponse(response => apiResponse(response, '/rest/v1/restaurant_members'))
  const ordersResponse = page.waitForResponse(response => apiResponse(response, '/rest/v1/orders') && response.request().method() === 'GET')
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click()
  const token = await tokenResponse
  expect(token.status(), 'The fixture operator must authenticate successfully').toBe(200)
  const session = object(await token.json())
  const apiKey = await token.request().headerValue('apikey')
  if (typeof session.access_token !== 'string' || !apiKey) throw new Error('Operator session credentials were not returned')
  const authorization = await authorizationResponse
  expect(authorization.status()).toBe(200)
  expect(object(await authorization.json()).isSuperAdmin, 'Use an ordinary tenant operator, never a super administrator').toBe(false)
  const memberships = await membershipsResponse
  expect(memberships.status()).toBe(200)
  const parsedMemberships = z.array(z.object({
    restaurant_id: z.uuid(), status: z.string(), role: z.enum(['order_manager', 'restaurant_admin']),
    restaurants: z.object({ slug: z.string(), status: z.string() }),
  })).safeParse(await memberships.json())
  if (!parsedMemberships.success) throw new Error('Unexpected operator membership response')
  const active = parsedMemberships.data.filter(membership => membership.status === 'active')
  expect(active.length, 'The acceptance operator needs exactly one active fixture membership').toBe(1)
  const membership = active[0]!
  expect(membership.restaurants.slug === required('E2E_RESTAURANT_SLUG') && membership.restaurants.status === 'active',
    'The operator must belong to the active fixture restaurant').toBe(true)
  // MFA and restaurant selection are not successful orders acceptance.
  await expect(page).toHaveURL(url => url.pathname === '/admin/pedidos')
  await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()
  const orders = await ordersResponse
  expect(orders.status(), 'The orders page must load successfully under the operator JWT').toBe(200)
  const rows: unknown = await orders.json()
  expect(Array.isArray(rows) && rows.every(row => object(row).restaurant_id === membership.restaurant_id),
    'The displayed list must contain only the selected fixture restaurant').toBe(true)
  return { restaurantId: membership.restaurant_id, headers: { apikey: apiKey, Authorization: `Bearer ${session.access_token}` } }
}

const snapshotSchema = z.object({
  id: z.uuid(), restaurantId: z.uuid(), actionId: z.uuid(), displayNumber: z.string().min(1),
  status: z.enum(['generated', 'whatsapp_opened', 'accepted', 'completed', 'cancelled', 'expired']),
  acceptedBy: z.uuid().nullable(), acceptedAt: z.string().nullable(), createdAt: z.string(),
  updatedAt: z.string(), events: z.array(z.unknown()),
}).passthrough()

async function orderSnapshot(request: APIRequestContext, operator: OperatorSession) {
  const actionId = required('E2E_ACTION_ID')
  const response = await request.post(`${required('E2E_SUPABASE_URL')}/rest/v1/rpc/get_order_by_action`, {
    headers: operator.headers, data: { p_action_id: actionId }, maxRedirects: 0,
  })
  expect(response.status(), 'The operator must be authorized to read the claim fixture').toBe(200)
  const parsed = snapshotSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error('Unexpected claim fixture snapshot')
  expect(parsed.data.actionId === actionId && parsed.data.restaurantId === operator.restaurantId,
    'Claim fixture identity must match the selected tenant and action').toBe(true)
  return parsed.data
}

// Compare full server state and history without printing customer fields or tokens on failure.
function snapshotDigest(snapshot: z.infer<typeof snapshotSchema>) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

test.describe('live Supabase acceptance flows', () => {
  test.skip(!live, 'Requires an explicitly selected isolated backend and E2E_LIVE=1.')
  // An uncertain checkout retry in a fresh browser context would create another synthetic order.
  test.describe.configure({ retries: 0 })

  test('customer loads the published fixture product and reaches checkout', async ({ page }) => {
    await reachCheckout(page)
  })

  test('customer creates a real order and recovers the same WhatsApp confirmation', async ({ page }) => {
    test.skip(process.env.E2E_CREATE_ORDER !== '1', 'Creating a synthetic order requires E2E_CREATE_ORDER=1.')
    const slug = required('E2E_RESTAURANT_SLUG')
    required('E2E_BASE_URL')
    await reachCheckout(page)
    await page.getByLabel('Nombre y apellido', { exact: true }).fill('Aceptación sintética Mozzi')
    await page.getByLabel('Teléfono', { exact: true }).fill('+5491100000000')
    // Respect the real anti-spam minimum age; do not replace the clock or bypass the check.
    await page.waitForTimeout(1_100)
    const created = page.waitForResponse(response => apiResponse(response, '/functions/v1/create-order') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Generar pedido', exact: true }).click()
    const createdResponse = await created
    expect([200, 201].includes(createdResponse.status()), 'The real checkout must commit successfully').toBe(true)
    const parsed = generatedOrderSchema.safeParse(await createdResponse.json())
    if (!parsed.success) throw new Error('The real checkout returned an invalid confirmation')
    expect(parsed.data.order.status).toBe('generated')
    expect(Number(parsed.data.order.totalCents)).toBeGreaterThan(0)
    expect(/^\+[1-9]\d{7,14}$/.test(parsed.data.whatsapp.phone)).toBe(true)
    expect(new URL(parsed.data.whatsapp.url).searchParams.has('text')).toBe(true)
    await expect(page).toHaveURL(url => url.pathname === `/r/${slug}/pedido-generado`)
    await expect(page.getByRole('heading', { name: parsed.data.order.displayNumber, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir WhatsApp', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Quitar acceso guardado en este dispositivo', exact: true })).toBeVisible()
    const recoveredResponse = page.waitForResponse(response => apiResponse(response, '/functions/v1/recover-order') && response.request().method() === 'POST')
    await page.reload()
    const recovered = await recoveredResponse
    expect(recovered.status(), 'Reload must recover the committed order from the backend').toBe(200)
    const recoveredOrder = generatedOrderSchema.safeParse(await recovered.json())
    if (!recoveredOrder.success) throw new Error('The backend returned an invalid recovered confirmation')
    expect(recoveredOrder.data.order.actionId === parsed.data.order.actionId
      && recoveredOrder.data.order.displayNumber === parsed.data.order.displayNumber, 'Reload must keep the same committed order').toBe(true)
    await expect(page.getByRole('heading', { name: parsed.data.order.displayNumber, exact: true })).toBeVisible()
    // Do not open WhatsApp, send messages, or claim the generated order.
  })

  test('restaurant operator authenticates and opens the fixture order in the orders list', async ({ page, request }) => {
    const operator = await loginOperator(page)
    const order = await orderSnapshot(request, operator)
    // Include older fixtures regardless of the default current-day filter.
    const day = new Date(order.createdAt)
    if (!Number.isFinite(day.valueOf())) throw new Error('The fixture creation date is invalid')
    const date = (offset: number) => new Date(day.valueOf() + offset * 86_400_000).toISOString().slice(0, 10)
    await page.goto(`/admin/pedidos?${new URLSearchParams({ q: order.displayNumber, from: date(-1), to: date(1) })}`)
    await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: `Ver ${order.displayNumber}`, exact: true })).toBeVisible()
  })

  test('GET and authenticated opening of a claim link leave order state and history unchanged', async ({ page, request }) => {
    const operator = await loginOperator(page)
    const before = await orderSnapshot(request, operator)
    expect(['generated', 'whatsapp_opened'].includes(before.status) && before.acceptedBy === null && before.acceptedAt === null,
      'Use an unclaimed fixture without concurrent operators or imminent expiration').toBe(true)
    const path = `/admin/pedidos/tomar/${required('E2E_ACTION_ID')}`
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/html')
    expect((await response.text()).includes('<div id="root"></div>')).toBe(true)
    expect(snapshotDigest(await orderSnapshot(request, operator)) === snapshotDigest(before), 'HTTP GET changed order state or history').toBe(true)
    let automaticClaims = 0
    page.on('request', outgoing => {
      if (new URL(outgoing.url()).pathname === '/rest/v1/rpc/claim_order') automaticClaims++
    })
    await page.goto(path)
    await expect(page).toHaveURL(url => url.pathname === path)
    await expect(page.getByRole('heading', { name: before.displayNumber, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Aceptar pedido|Aceptar y reservar)$/ })).toBeEnabled()
    expect(snapshotDigest(await orderSnapshot(request, operator)) === snapshotDigest(before), 'Opening the authenticated claim page changed order state or history').toBe(true)
    expect(automaticClaims, 'Opening the page must not invoke claim_order').toBe(0)
  })
})
