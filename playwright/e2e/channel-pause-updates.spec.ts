import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

test.describe('channel pause updates (full revert to built-in)', () => {
  test('shows the pause action on the channel page and confirms before reverting', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/app/com.demo.app/channel/1')
    await dismissSupportPrompt(page)

    const pauseRow = page.locator('[data-test="channel-pause-updates"]')
    await expect(pauseRow).toBeVisible({ timeout: 30000 })
    await expect(pauseRow).toContainText('Pause updates (full revert)')

    const revertButton = pauseRow.getByRole('button', { name: 'Revert all devices to built-in' })
    await expect(revertButton).toBeEnabled({ timeout: 60000 })
    await revertButton.click()

    await expect(page.locator('h3').filter({ hasText: 'Pause updates and revert to built-in?' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Capgo stops sending updates on this channel until you assign a bundle again.')).toBeVisible()

    // Cancel so the shared seed channel keeps its bundle for other specs.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('[data-test="channel-summary-paused"]')).toHaveCount(0)
    await expect(revertButton).toBeVisible()
  })
})
