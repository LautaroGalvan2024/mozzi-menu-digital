import { expect, type Page } from '@playwright/test'

export async function selectAdminSection(page: Page, navigation: string, label: string) {
  const menu = page.getByRole('navigation', { name: navigation, exact: true })
  await expect(menu).toBeVisible()
  const picker = menu.getByRole('combobox')
  if (await picker.isVisible()) await picker.selectOption({ label })
  else await menu.getByRole('button', { name: label, exact: true }).click()
}
