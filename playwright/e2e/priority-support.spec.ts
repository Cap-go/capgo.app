import { expect, test } from '../support/commands'

test.describe('Priority plugin support', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('opens GitHub linking from the priority-support handoff', async ({ page }) => {
    await page.goto('/settings/account?connect=github&from=priority-support&tab=profile')

    await expect(page).toHaveURL(/\/settings\/account\?(?=[^#]*from=priority-support)(?=[^#]*tab=profile)(?![^#]*connect=github)/)
    await expect(page.getByRole('heading', { name: 'GitHub username', exact: true })).toBeVisible()
    await expect(page.locator('#github-username-input')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'GitHub username', exact: true })).not.toBeVisible()
  })
})
