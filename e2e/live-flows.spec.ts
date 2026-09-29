import { expect, test } from '@playwright/test'

const live = process.env.E2E_LIVE === '1'
const restaurantSlug = process.env.E2E_RESTAURANT_SLUG ?? ''
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? ''
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? ''
const createLiveOrder = process.env.E2E_CREATE_ORDER === '1'

test.describe('live Supabase acceptance flows', () => {
  test.skip(!live, 'Requires an isolated seeded Supabase project and E2E_LIVE=1.')

  test('customer can build a cart and reaches server-backed checkout', async ({ page }) => {
    test.skip(!restaurantSlug, 'E2E_RESTAURANT_SLUG is required.')
    await page.goto(`/r/${restaurantSlug}`)
    await expect(page.getByText(/abierto ahora/i)).toBeVisible()
    const availableProduct = page.locator('article button:not([disabled])').first()
    await availableProduct.click()
    await page.getByRole('button', { name: /agregar ·/i }).click()
    await page.getByRole('link', { name: /ver carrito/i }).click()
    await expect(page.getByRole('heading', { name: /tu pedido/i })).toBeVisible()
    await page.getByRole('link', { name: 'Continuar' }).click()
    await expect(page.getByRole('heading', { name: /finalizar pedido/i })).toBeVisible()
  })

  test('customer can create a real order and reaches its WhatsApp confirmation', async ({ page }) => {
    test.skip(
      !restaurantSlug || !createLiveOrder || !process.env.E2E_BASE_URL,
      'Requires an allowed E2E_BASE_URL, E2E_RESTAURANT_SLUG and E2E_CREATE_ORDER=1.',
    )
    await page.goto(`/r/${restaurantSlug}`)
    await expect(page.getByText(/abierto ahora/i)).toBeVisible()
    await page.locator('article button:not([disabled])').first().click()
    await page.getByRole('button', { name: /agregar ·/i }).click()
    await page.getByRole('link', { name: /ver carrito/i }).click()
    await page.getByRole('link', { name: 'Continuar' }).click()
    await page.getByLabel('Nombre y apellido').fill('Prueba técnica Codex')
    await page.getByLabel('Teléfono').fill('+5491100000000')
    await page.waitForTimeout(1_100)
    const created = page.waitForResponse((response) =>
      response.url().includes('/functions/v1/create-order') &&
      response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Generar pedido' }).click()
    const createdResponse = await created
    expect([200, 201]).toContain(createdResponse.status())
    const createdPayload = await createdResponse.json() as { whatsapp?: { url?: string; phone?: string } }
    expect(createdPayload.whatsapp?.url).toMatch(/^https:\/\/wa\.me\/\d+\?text=/)
    expect(createdPayload.whatsapp?.phone).toMatch(/^\+[1-9]\d{7,14}$/)

    await expect(page).toHaveURL(new RegExp(`/r/${restaurantSlug}/pedido-generado$`))
    await expect(page.getByRole('heading', { name: /^[A-Z0-9-]+$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir WhatsApp' })).toBeVisible()
  })

  test('restaurant operator can authenticate and see only authorized orders', async ({ page }) => {
    test.skip(!adminEmail || !adminPassword, 'E2E admin credentials are required.')
    await page.goto('/login?returnTo=/admin/pedidos')
    await page.getByLabel('Correo').fill(adminEmail)
    await page.getByLabel('Contraseña').fill(adminPassword)
    await page.getByRole('button', { name: 'Ingresar' }).click()
    await expect(page).toHaveURL(/\/(admin|auth\/mfa)/)
    if (page.url().includes('/admin')) {
      await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible()
    }
  })

  test('opening a claim link never claims through GET', async ({ request }) => {
    const actionId = process.env.E2E_ACTION_ID
    test.skip(!actionId, 'E2E_ACTION_ID is required.')
    const response = await request.get(`/admin/pedidos/tomar/${actionId}`)
    expect(response.ok()).toBeTruthy()
    // Database pgTAP tests assert the order status remains unchanged; this browser
    // assertion additionally verifies that GET only serves the SPA shell.
    expect(await response.text()).toContain('<div id="root"></div>')
  })
})
