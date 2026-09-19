import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = '/opt/cursor/artifacts/screenshots'

test.describe('PR 3390 second app getting started screenshot', () => {
  test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5175/' })
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  test('capture getting started after creating a second app', async ({ page }) => {
    const suffix = Date.now()
    const appName = `Second App ${suffix}`
    const appId = `com.test.secondapp.${suffix}`

    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })

    await page.login('test@capgo.app', 'testtest')
    await dismissSupportPrompt(page)

    await page.goto('/app/new?onboarding=false')
    await page.click('[data-test="app-onboarding-existing-no"]')
    await page.fill('[data-test="app-onboarding-name"]', appName)
    await page.click('[data-test="app-onboarding-continue"]')
    await page.waitForSelector('[data-test="app-onboarding-skip-app-id"]', { timeout: 60000 })
    await page.click('[data-test="app-onboarding-skip-app-id"]')
    await page.waitForSelector('#app-onboarding-app-id', { timeout: 60000 })
    await page.fill('#app-onboarding-app-id', appId)
    await page.click('[data-test="app-onboarding-continue"]')

    await expect(page).toHaveURL(new RegExp(`/app/${appId.replace(/\./g, '\\.')}/getting-started`), { timeout: 120000 })
    await expect(page.locator('[data-test="dashboard-shell"]')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('[data-test="getting-started-cli-panel"]')).toBeVisible({ timeout: 120000 })
    await expect(page.locator('[data-test="getting-started-cli-command-copy"], [data-test="getting-started-cli-command-loading"]')).toBeVisible({ timeout: 120000 })

    const screenshotPath = resolve(screenshotDir, 'pr-3390-second-app-getting-started.webp')
    await page.screenshot({ path: screenshotPath, type: 'webp', fullPage: false })
    console.log(`SCREENSHOT=${screenshotPath}`)
    console.log(`APP_ID=${appId}`)
  })
})
