import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'
import { setupTinbaseEdgeStubs } from '../support/tinbaseEdgeStubs'

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

    await setupTinbaseEdgeStubs(page)

    await page.login('test@capgo.app', 'testtest')
    await dismissSupportPrompt(page)

    await page.goto('/app/new?onboarding=false')
    await page.waitForSelector('[data-test="app-onboarding-existing-no"]', { timeout: 120000 })
    await page.click('[data-test="app-onboarding-existing-no"]')
    await page.fill('[data-test="app-onboarding-name"]', appName)
    await page.click('[data-test="app-onboarding-continue"]')
    await page.waitForSelector('#app-onboarding-app-id', { timeout: 60000 })
    await page.fill('#app-onboarding-app-id', appId)
    await page.click('[data-test="app-onboarding-continue"]')
    await page.getByRole('heading', { name: 'Choose an icon' }).waitFor({ timeout: 60000 })
    await page.click('[data-test="app-onboarding-continue"]')

    await expect(page).toHaveURL(new RegExp(`/app/${appId.replace(/\./g, '\\.')}/getting-started`), { timeout: 120000 })
    await expect(page.locator('[data-test="dashboard-shell"]')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('[data-test="getting-started-cli-panel"]')).toBeVisible({ timeout: 120000 })
    await expect(page.locator('[data-test="getting-started-cli-command-copy"], [data-test="getting-started-cli-command-loading"]')).toBeVisible({ timeout: 120000 })

    const screenshotPath = resolve(screenshotDir, 'pr-3390-second-app-getting-started.webp')
    const pngPath = `${screenshotPath}.png`
    await page.screenshot({ path: pngPath, type: 'png', fullPage: false })
    const convert = spawnSync('ffmpeg', ['-y', '-i', pngPath, screenshotPath], { stdio: 'inherit' })
    if ((convert.status ?? 1) !== 0)
      throw new Error(`Failed to convert screenshot to webp (exit ${convert.status ?? 1})`)
    console.log(`SCREENSHOT=${screenshotPath}`)
    console.log(`APP_ID=${appId}`)
  })
})
