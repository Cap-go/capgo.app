import { expect, test } from '../support/commands'

test('saves and reloads the incompatible-bundle alert scope', async ({ page }) => {
  await page.login('test@capgo.app', 'testtest')
  await page.goto('/app/com.demo.app/settings')

  const scope = page.locator('#bundle-incompatible-alert')
  await expect(scope).toBeVisible()
  await expect(scope).toHaveValue('default')

  await scope.selectOption('all')
  await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Updated incompatible bundle alerts')).toBeVisible()

  await page.reload()
  await expect(scope).toHaveValue('all')

  await scope.selectOption('default')
  await page.locator('#update-app').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Updated incompatible bundle alerts')).toBeVisible()
  await page.reload()
  await expect(scope).toHaveValue('default')
})
