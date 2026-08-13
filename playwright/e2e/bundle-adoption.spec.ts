import { expect, test } from '../support/commands'

test.describe('Bundle reach', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('shows reach on the bundle page and observe updater', async ({ page }) => {
    await page.goto('/app/com.demo.app/bundle/3')
    const bundleCard = page.locator('[data-test="bundle-adoption-card"]')
    await expect(bundleCard).toBeVisible()
    await expect(bundleCard.getByRole('heading', { name: 'Bundle reach' })).toBeVisible()

    await page.locator('[data-test="bundle-adoption-devices"]').click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/devices\?version=1\.0\.0/)

    await page.goto('/app/com.demo.app/bundle/3')
    await page.locator('[data-test="bundle-adoption-channel"]').click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/channel\/\d+\/statistics/)

    await page.goto('/app/com.demo.app/observe/updater')
    await expect(page.locator('[data-test="bundle-adoption-card"]')).toBeVisible()

    await page.goto('/app/com.demo.app')
    await expect(page.locator('[data-test="release-banner"]')).toBeVisible()
  })
})
