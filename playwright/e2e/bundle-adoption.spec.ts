import { expect, test } from '../support/commands'

test.describe('Bundle reach', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('shows reach on observe updater', async ({ page }) => {
    await page.goto('/app/com.demo.app/observe/updater')
    const reachCard = page.locator('[data-test="bundle-adoption-card"]').first()
    await expect(reachCard).toBeVisible()
    await expect(reachCard).toContainText('Bundle reach')

    await reachCard.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/channel\/\d+\/statistics/)
  })
})
