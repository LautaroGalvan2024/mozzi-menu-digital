import { expect, test, type Locator, type Page } from '@playwright/test'
import { items, offerOrderFixture, offerOrderState, slug } from './offer-order-fixture'

const names = items.map(item => item.name)
const adminPath = '/admin/catalogo/productos'
const openButton = (page: Page) => page.getByRole('button', { name: 'Ordenar ofertas', exact: true })
const dialogFor = (page: Page) => page.getByRole('dialog', { name: 'Ordenar ofertas', exact: true })
const rows = (dialog: Locator) => dialog.getByRole('list', { name: 'Productos en oferta' }).getByRole('listitem')
const saveButton = (dialog: Locator) => dialog.getByRole('button', { name: 'Guardar orden' })

async function openEditor(page: Page) {
  await page.goto(adminPath)
  await openButton(page).click()
  const dialog = dialogFor(page)
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('store offer order', () => {
  test.skip(Boolean(process.env.E2E_BASE_URL) || process.env.E2E_LIVE === '1', 'Uses the isolated e2e.invalid fixture.')

  for (const mobile of [false, true]) {
    test.describe(mobile ? 'mobile' : 'desktop', () => {
      test.use({ hasTouch: mobile, isMobile: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } })

      test('saves the chosen sequence and shows it only in the offer shelf', async ({ page }, testInfo) => {
        const { state, unexpected } = await offerOrderFixture(page)
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', event => { if (event.type() === 'error') errors.push(event.text()) })
        const dialog = await openEditor(page)
        const list = rows(dialog)
        await expect(list).toContainText(names)
        await expect(saveButton(dialog)).toBeDisabled()
        await expect(dialog.getByRole('button', { name: `Subir ${names[0]}` })).toBeDisabled()
        await expect(dialog.getByRole('button', { name: `Bajar ${names[3]}` })).toBeDisabled()
        await expect(list.nth(2).locator('img')).toHaveCount(0)
        await expect.poll(() => list.first().locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
        const next = [names[3]!, ...names.slice(0, 3)]
        if (mobile) {
          const move = dialog.getByRole('button', { name: `Subir ${names[3]}` })
          for (let step = 0; step < 3; step++) await move.tap()
        } else {
          await dialog.getByLabel(`Arrastrar ${names[3]}`).dragTo(list.first())
        }
        await expect(list).toContainText(next)
        await expect(list.first()).toContainText('Se muestra primero')
        await expect(saveButton(dialog)).toBeEnabled()
        await expect(saveButton(dialog)).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('administrador.png') })

        await saveButton(dialog).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.getByRole('status').filter({ hasText: 'El orden de tus ofertas se guardó correctamente.' })).toBeVisible()
        expect(state.ids).toEqual([items[3]!.id, ...items.slice(0, 3).map(item => item.id)])
        expect(state.writes).toBe(1)
        await page.reload()
        await openButton(page).click()
        await expect(rows(dialog)).toContainText(next)
        await expect(saveButton(dialog)).toBeDisabled()
        await dialog.getByRole('button', { name: 'Cancelar' }).click()

        await page.goto(`/t/${slug}`)
        const shelf = page.getByRole('region', { name: 'Ofertas para aprovechar' })
        await expect(shelf.getByRole('heading', { level: 3 })).toHaveText(next)
        await expect(shelf.getByRole('img', { name: 'Producto sin foto' })).toBeVisible()
        await expect(page.locator('#store-products').getByRole('heading', { level: 3 })).toHaveText(names)
        // Leave room for the storefront's sticky search bar above the shelf title.
        await shelf.evaluate(el => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 106, behavior: 'instant' }))
        await page.screenshot({ path: testInfo.outputPath('tienda.png') })
        await shelf.getByRole('button', { name: 'Ver todos' }).click()
        await expect(page.getByRole('heading', { name: 'Todas las ofertas' })).toBeVisible()
        await expect(page.locator('#store-products').getByRole('heading', { level: 3 })).toHaveText(next)
        expect(unexpected).toEqual([])
        expect(errors).toEqual([])
      })
    })
  }

  test.describe('small touch screen', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 640 } })
    test('supports touch dragging and keeps actions accessible with many offers', async ({ page, context }) => {
      await offerOrderFixture(page)
      const many = Array.from({ length: 30 }, (_, i) => ({
        ...items[0]!, id: `36900000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        name: `Producto de almacén ${i + 1}`, image_path: null,
      }))
      await page.route('**/rpc/get_store_offer_order', route => route.fulfill({ json: { revision: '1', items: many } }))
      const dialog = await openEditor(page)
      const list = rows(dialog)
      await expect(list).toHaveCount(many.length)
      const source = await dialog.getByLabel(`Arrastrar ${many[0]!.name}`, { exact: true }).boundingBox()
      const target = await list.nth(1).boundingBox()
      expect(source).not.toBeNull()
      expect(target).not.toBeNull()
      const x = source!.x + source!.width / 2
      const fromY = source!.y + source!.height / 2
      const toY = target!.y + target!.height / 2
      const client = await context.newCDPSession(page)
      try {
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] })
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: toY }] })
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } finally { await client.detach() }
      await expect(list.first()).toContainText(many[1]!.name)
      await expect(saveButton(dialog)).toBeEnabled()
      await list.last().scrollIntoViewIfNeeded()
      await expect(list.last()).toBeInViewport()
      await expect(saveButton(dialog)).toBeInViewport()
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    })
  })

  test('keeps keyboard changes after Escape and discards them when confirmed', async ({ page }) => {
    const { state } = await offerOrderFixture(page)
    const dialog = await openEditor(page)
    const move = dialog.getByRole('button', { name: `Bajar ${names[0]}` })
    for (let step = 0; step < 3; step++) await move.press('Enter')
    await expect(rows(dialog)).toContainText([...names.slice(1), names[0]!])
    await page.keyboard.press('Escape')
    const confirm = page.getByRole('dialog', { name: '¿Descartar los cambios?' })
    await confirm.getByRole('button', { name: 'Cancelar' }).click()
    await expect(rows(dialog).last()).toContainText(names[0]!)
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await confirm.getByRole('button', { name: 'Descartar cambios' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(openButton(page)).toBeFocused()
    await openButton(page).click()
    await expect(rows(dialog)).toContainText(names)
    expect(state.writes).toBe(0)
  })

  test('preserves the draft across a failed save and allows a retry', async ({ page }) => {
    const { state } = await offerOrderFixture(page)
    await page.route('**/rpc/save_store_offer_order', route => route.fulfill({ status: 503, json: { message: 'Service unavailable' } }), { times: 1 })
    const dialog = await openEditor(page)
    await dialog.getByRole('button', { name: `Subir ${names[1]}` }).click()
    await saveButton(dialog).click()
    await expect(dialog.getByRole('alert')).toContainText('Conservamos tus cambios')
    await expect(rows(dialog).first()).toContainText(names[1]!)
    expect(state.writes).toBe(0)
    await saveButton(dialog).click()
    await expect(dialog).toHaveCount(0)
    expect(state.writes).toBe(1)
  })

  test('recovers a failed initial load, waits for connectivity and prevents duplicate saves', async ({ page, context }) => {
    const { state } = await offerOrderFixture(page)
    let finishLoading!: () => void
    const loading = new Promise<void>(resolve => { finishLoading = resolve })
    let failInitialLoad = true
    await page.route('**/rpc/get_store_offer_order', async route => {
      if (!failInitialLoad) return route.fallback()
      await loading
      await route.fulfill({ status: 503, json: { message: 'Service unavailable' } })
    })
    const dialog = await openEditor(page)
    await expect(dialog.getByRole('status')).toHaveText('Cargando ofertas…')
    await expect(saveButton(dialog)).toBeDisabled()
    finishLoading()
    await expect(dialog.getByRole('alert')).toContainText('No se pudieron cargar')
    failInitialLoad = false
    await dialog.getByRole('button', { name: 'Reintentar' }).click()
    await dialog.getByRole('button', { name: `Bajar ${names[0]}` }).click()
    await context.setOffline(true)
    await expect(dialog.getByText(/Sin conexión/)).toBeVisible()
    await expect(saveButton(dialog)).toBeDisabled()
    await context.setOffline(false)
    await expect(saveButton(dialog)).toBeEnabled()
    let finishSaving!: () => void
    const saving = new Promise<void>(resolve => { finishSaving = resolve })
    await page.route('**/rpc/save_store_offer_order', async route => { await saving; await route.fallback() }, { times: 1 })
    await saveButton(dialog).click()
    await expect(dialog.getByRole('button', { name: 'Guardando…' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    finishSaving()
    await expect(dialog).toHaveCount(0)
    expect(state.writes).toBe(1)
  })

  test('reviews concurrent changes before saving again', async ({ page, context }) => {
    const { state } = await offerOrderFixture(page)
    const dialog = await openEditor(page)
    await dialog.getByRole('button', { name: `Bajar ${names[0]}` }).click()
    const otherTab = await context.newPage()
    await offerOrderFixture(otherTab, state)
    const otherDialog = await openEditor(otherTab)
    await otherDialog.getByRole('button', { name: `Subir ${names[3]}` }).click()
    await saveButton(otherDialog).click()
    await expect(otherDialog).toHaveCount(0)
    await saveButton(dialog).click()
    await expect(dialog.getByRole('alert')).toContainText('Las ofertas cambiaron')
    await expect(rows(dialog)).toContainText([names[1]!, names[0]!, names[3]!, names[2]!])
    expect(state.writes).toBe(1)
    await saveButton(dialog).click()
    await expect(dialog).toHaveCount(0)
    expect(state.writes).toBe(2)
    expect(state.ids).toEqual([items[1]!.id, items[0]!.id, items[3]!.id, items[2]!.id])
  })

  for (const count of [0, 1]) {
    test(`disables saving with ${count} eligible offers`, async ({ page }) => {
      await offerOrderFixture(page, offerOrderState(count))
      const response = page.waitForResponse('**/rpc/get_store_offer_order')
      const dialog = await openEditor(page)
      await response
      if (count === 0) await expect(dialog.getByText(/no hay .*ofertas|sin ofertas|no tenés .*oferta/i).first()).toBeVisible()
      else {
        await expect(rows(dialog)).toHaveCount(1)
        await expect(dialog.getByRole('button', { name: `Subir ${names[0]}` })).toBeDisabled()
        await expect(dialog.getByRole('button', { name: `Bajar ${names[0]}` })).toBeDisabled()
      }
      await expect(saveButton(dialog)).toBeDisabled()
    })
  }

  test('keeps the action out of a menu-only commerce', async ({ page }) => {
    const { unexpected } = await offerOrderFixture(page, offerOrderState(), false)
    await page.goto(adminPath)
    await expect(page.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible()
    await expect(openButton(page)).toHaveCount(0)
    expect(unexpected).toEqual([])
  })
})
