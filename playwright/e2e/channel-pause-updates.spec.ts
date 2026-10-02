import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

test.describe('channel bundle actions (change, pause, revert)', () => {
  test('shows the actions next to the bundle and confirms before pausing or reverting', async ({ page }) => {
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

    const bundleRow = page.locator('[data-test="channel-bundle-row"]')
    await expect(bundleRow).toBeVisible({ timeout: 30000 })
    await expect(bundleRow.locator('[data-test="channel-change-bundle"]')).toHaveText('Change bundle')

    const pauseButton = bundleRow.locator('[data-test="channel-pause-toggle"]')
    await expect(pauseButton).toHaveText('Pause updates')
    await expect(pauseButton).toBeEnabled({ timeout: 60000 })
    await pauseButton.click()
    await expect(page.locator('h3').filter({ hasText: 'Pause updates on this channel?' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Devices keep the bundle they already run and nothing is rolled back.', { exact: false })).toBeVisible()
    // Cancel so the shared seed channel keeps serving for other specs.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('[data-test="channel-paused-banner"]')).toHaveCount(0)

    const revertButton = bundleRow.locator('[data-test="channel-revert-builtin"]')
    await expect(revertButton).toBeEnabled()
    await revertButton.click()
    await expect(page.locator('h3').filter({ hasText: 'Revert all devices to built-in?' })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(pauseButton).toHaveText('Pause updates')
  })
})
