import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/screenshots/pr-3280')

async function dismissOptionalPrompts(page: import('@playwright/test').Page) {
  await dismissSupportPrompt(page)
  const remindLater = page.getByRole('button', { name: 'Remind me later', exact: true })
  if (await remindLater.isVisible().catch(() => false))
    await remindLater.click()
}

// Local: start Tinbase on 55321, then:
// CAPGO_PR_SCREENSHOTS=1 SKIP_BACKEND_START=1 SKIP_FRONTEND_START=1 \
//   SUPABASE_URL=http://127.0.0.1:55321 SUPABASE_ANON_KEY=<tinbase anon> \
//   bunx playwright test playwright/e2e/pr-3280-security-screenshots.spec.ts
test.describe('PR 3280 organization security screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  test('capture password policy UI on organization security settings', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })

    await page.login('test@capgo.app', 'testtest')
    await page.goto('/settings/organization/Security')
    await dismissOptionalPrompts(page)

    await expect(page.getByRole('heading', { name: 'Password Policy' })).toBeVisible({ timeout: 30000 })
    const policySection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Password Policy' }) })
    await policySection.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: resolve(screenshotDir, 'organization-security-password-policy.png'),
      fullPage: false,
    })

    const policyToggle = page.getByRole('checkbox', { name: 'Enforce Password Policy' })
    await expect(policyToggle).toBeVisible()
    if (await policyToggle.isChecked()) {
      await policyToggle.click({ force: true })
      await page.waitForTimeout(300)
    }

    await policyToggle.click({ force: true })
    const warningTitle = page.getByRole('heading', { name: 'Enable Password Policy' })
    if (await warningTitle.isVisible({ timeout: 10000 }).catch(() => false)) {
      await page.screenshot({
        path: resolve(screenshotDir, 'password-policy-enable-warning-dialog.png'),
      })
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
      if (await cancel.isVisible().catch(() => false))
        await cancel.click()
    }
    else if (await policyToggle.isChecked()) {
      await expect(page.locator('#password-policy-min-length')).toBeVisible()
      await page.screenshot({
        path: resolve(screenshotDir, 'password-policy-enabled-options.png'),
      })
      await policyToggle.click({ force: true })
    }
    else {
      expect(false, 'Password policy toggle did not show the warning dialog or enable the policy').toBe(true)
    }
  })
})
