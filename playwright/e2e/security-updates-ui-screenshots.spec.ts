import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/screenshots/security-updates-ui')
const phase = process.env.CAPGO_SCREENSHOT_PHASE === 'before' ? 'before' : 'after'

async function dismissOptionalPrompts(page: import('@playwright/test').Page) {
  await dismissSupportPrompt(page)
  const remindLater = page.getByRole('button', { name: 'Remind me later', exact: true })
  if (await remindLater.isVisible().catch(() => false))
    await remindLater.click()
}

test.describe('Security updates UI screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ] as const) {
    test(`${phase} account notifications (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/settings/account/notifications')
      await dismissOptionalPrompts(page)
      await expect(page.getByRole('heading', { name: 'My notifications' })).toBeVisible({ timeout: 60_000 })

      if (phase === 'after') {
        await expect(page.getByText('Security advisories')).toBeVisible()
        await expect(page.getByTestId('security-updates-email-toggle')).toBeVisible()
      }
      else {
        await expect(page.getByText('Security advisories')).toHaveCount(0)
        await expect(page.getByTestId('security-updates-email-toggle')).toHaveCount(0)
      }

      await page.screenshot({
        path: resolve(screenshotDir, `${phase}-${viewport.name}-account-notifications.png`),
        fullPage: true,
        animations: 'disabled',
      })
    })

    test(`${phase} observe security UI (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.login('test@capgo.app', 'testtest')

      if (phase === 'before') {
        await page.goto('/app/com.demo.app/observe/errors')
        await dismissOptionalPrompts(page)
        await expect(page.getByRole('button', { name: /security updates/i })).toHaveCount(0)
        await page.screenshot({
          path: resolve(screenshotDir, `${phase}-${viewport.name}-app-observe-before.png`),
          fullPage: true,
          animations: 'disabled',
        })
        return
      }

      await page.goto('/app/com.demo.app/observe/security')
      await dismissOptionalPrompts(page)
      await expect(page.getByTestId('security-updates-feed')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('security-advisory-match-card')).toHaveCount(2, { timeout: 60_000 })
      const statuses = await page.getByTestId('security-advisory-match-card').allTextContents()
      expect(statuses.some(text => /Affected/i.test(text))).toBe(true)
      expect(statuses.some(text => /Unknown/i.test(text))).toBe(true)

      await page.screenshot({
        path: resolve(screenshotDir, `${phase}-${viewport.name}-app-security-updates.png`),
        fullPage: true,
        animations: 'disabled',
      })
    })
  }
})
