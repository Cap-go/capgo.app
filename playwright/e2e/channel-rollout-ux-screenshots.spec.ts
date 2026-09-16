import { expect, test } from '../support/commands'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const screenshotDir = resolve(process.cwd(), 'docs/pr-screenshots/pr-3340')

async function dismissOptionalPrompts(page: import('@playwright/test').Page) {
  const remindLater = page.getByRole('button', { name: 'Remind me later', exact: true })
  if (await remindLater.isVisible().catch(() => false))
    await remindLater.click()
}

// Local-only: CAPGO_PR_SCREENSHOTS=1 bunx playwright test playwright/e2e/channel-rollout-ux-screenshots.spec.ts
test.describe('PR 3340 channel UX screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  test('capture download format and rollout confirmation UI', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/app/com.demo.app/channel/1')
    await expect(page.getByText('Download format', { exact: false }).first()).toBeVisible({ timeout: 30000 })
    await dismissOptionalPrompts(page)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const percentInput = page.locator('#rollout-percentage-input')
    await expect(percentInput).toBeEnabled({ timeout: 60000 })
    await percentInput.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: resolve(screenshotDir, '05-rollout-apply-controls.png'),
      fullPage: false,
    })
    await percentInput.fill('25', { force: true })
    const applyPercent = page.getByRole('button', { name: 'Apply percentage', exact: true })
    await expect(applyPercent).toBeEnabled({ timeout: 15000 })
    await applyPercent.click()
    await expect(page.locator('h3').filter({ hasText: 'Apply rollout percentage?' })).toBeVisible()
    await page.screenshot({
      path: resolve(screenshotDir, '04-rollout-percentage-confirm.png'),
    })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: resolve(screenshotDir, '01-download-format-section.png'),
      fullPage: false,
    })

    const formatSummary = page.locator('summary').filter({ hasText: /Zip \+ delta|Full zip|Delta only/ }).first()
    await formatSummary.click()
    await expect(page.getByText('Delta only', { exact: true }).first()).toBeVisible()
    await page.screenshot({
      path: resolve(screenshotDir, '02-download-format-dropdown.png'),
    })

    await page.getByRole('button', { name: /^Delta only Only changed/ }).click()
    await expect(page.locator('h3').filter({ hasText: 'Change download format?' })).toBeVisible({ timeout: 15000 })
    await page.screenshot({
      path: resolve(screenshotDir, '03-download-format-confirm.png'),
    })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })

  test('capture bordered rollout actions and rollback confirm', async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/app/com.demo.app/channel/1')
    await expect(page.getByText('Progressive rollout', { exact: false }).first()).toBeVisible({ timeout: 30000 })
    await dismissOptionalPrompts(page)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await expect(page.getByRole('button', { name: 'Set target', exact: true })).toBeVisible({ timeout: 60000 })

    const actionRow = page.locator('button', { hasText: 'Set target' }).locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]')
    await actionRow.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: resolve(screenshotDir, '06-rollout-action-buttons-bordered.png'),
      fullPage: false,
    })

    await page.getByRole('button', { name: 'rollback', exact: true }).click()
    await expect(page.locator('h3').filter({ hasText: 'Roll back progressive rollout?' })).toBeVisible({ timeout: 15000 })
    await page.screenshot({
      path: resolve(screenshotDir, '07-rollout-rollback-confirm.png'),
    })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})
