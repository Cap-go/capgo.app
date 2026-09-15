import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/pr-screenshots')
const rowScreenshotPath = resolve(screenshotDir, 'logs-table-original-error-row.png')
const consoleScreenshotPath = resolve(screenshotDir, 'logs-table-original-error.png')

test.describe('PR screenshot — logs original error', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('capture observe logs row with translated label and original error', async ({ page }) => {
    mkdirSync(screenshotDir, { recursive: true })

    await page.goto('/app/com.demo.app/observe/logs')
    await dismissSupportPrompt(page)

    const row = page.locator('#custom_table tbody tr', { hasText: '44444444' })
    await expect(row.locator('[data-test="log-row-action"]')).toHaveText('WebView JavaScript error')
    await expect(row.locator('[data-test="log-row-original-error"]')).toHaveText('Uncaught ReferenceError: foo is not defined')

    await expect(page.getByRole('button', { name: 'Logs', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#custom_table thead')).toContainText(/action/i)

    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: consoleScreenshotPath, fullPage: false })
    await row.screenshot({ path: rowScreenshotPath })

    await expect(row.locator('[data-test="log-row-action"]')).toHaveAttribute(
      'title',
      /webview_javascript_error/,
    )
  })
})
