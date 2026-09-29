import { expect, test } from '@playwright/test'

test('landing and administrative login are reachable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /menús digitales/i })).toBeVisible()
  await page.getByRole('link', { name: /administración/i }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('heading', { name: /ingresá al panel/i })).toBeVisible()
  await expect(page.getByLabel('Contraseña')).toHaveAttribute('type', 'password')
})

test('an unknown route renders a controlled 404', async ({ page }) => {
  await page.goto('/ruta-inexistente')
  await expect(page.getByRole('heading', { name: /no encontramos/i })).toBeVisible()
})

test('an unavailable public menu fails safely with or without local configuration', async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_public_menu', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'PGRST116', message: 'not found' }),
    })
  })
  await page.goto('/r/restaurante-de-prueba')
  await expect(
    page.getByRole('heading', {
      name: /falta conectar supabase|no pudimos completar la operación/i,
    }),
  ).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/service_role|stack trace|postgresql:\/\//i)
})
