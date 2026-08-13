import { expect, test } from '../support/commands'

test.describe('Bundle reach', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('shows reach on observe updater', async ({ page }) => {
    await page.goto('/app/com.demo.app/observe/updater')
    const reachCard = page.locator('[data-test="bundle-adoption-card"]').first()
    await expect(page.getByRole('heading', { name: 'Bundle reach' })).toBeVisible()
    await expect(reachCard).toBeVisible()

    await page.locator('[data-test="bundle-adoption-devices"]').first().click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/devices\?version=/)

    await page.goto('/app/com.demo.app/observe/updater')
    await page.locator('[data-test="bundle-adoption-channel"]').first().click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/channel\/\d+\/statistics/)
  })
})
