import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/pr-screenshots/pr-3626')

// Local-only: CAPGO_PR_SCREENSHOTS=1 bunx playwright test playwright/e2e/past-due-banner-screenshots.spec.ts
test.describe('PR 3626 past-due banner screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`capture past-due banner (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.route('**/private/sso/check-enforcement', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      }))
      await page.route('**/private/stripe_past_due', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          past_due: true,
          invoice: {
            hosted_invoice_url: 'https://invoice.stripe.com/i/test',
            amount_due: 1400,
            currency: 'usd',
            attempt_count: 2,
            next_payment_attempt: new Date(Date.now() + 3 * 86400000).toISOString(),
          },
        }),
      }))
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/apps')
      await dismissSupportPrompt(page)
      const banner = page.locator('[data-test="past-due-banner"]')
      await expect(banner).toBeVisible({ timeout: 30000 })
      await page.waitForTimeout(1500)
      await page.screenshot({ path: resolve(screenshotDir, `past-due-banner-${scheme}.png`), animations: 'disabled' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(800)
      await page.screenshot({ path: resolve(screenshotDir, `past-due-banner-mobile-${scheme}.png`), animations: 'disabled' })
    })
  }
})
