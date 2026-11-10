import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/screenshots/admin-security-updates-ui')
const phase = process.env.CAPGO_SCREENSHOT_PHASE === 'before' ? 'before' : 'after'

async function dismissOptionalPrompts(page: import('@playwright/test').Page) {
  await dismissSupportPrompt(page)
  const remindLater = page.getByRole('button', { name: 'Remind me later', exact: true })
  if (await remindLater.isVisible().catch(() => false))
    await remindLater.click()
}

test.describe('Admin security updates UI screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ] as const) {
    test(`${phase} admin security updates tracking (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.login('admin@capgo.app', 'adminadmin')
      await page.goto('/admin/dashboard/security-updates')
      await dismissOptionalPrompts(page)

      if (phase === 'after') {
        await expect(page.getByTestId('admin-security-updates-page')).toBeVisible({ timeout: 120_000 })
        await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 120_000 })
      }
      else {
        await expect(page.getByTestId('admin-security-updates-page')).toHaveCount(0)
      }

      await page.screenshot({
        path: resolve(screenshotDir, `${phase}-${viewport.name}-admin-security-updates.png`),
        fullPage: true,
        animations: 'disabled',
      })
    })
  }
})
