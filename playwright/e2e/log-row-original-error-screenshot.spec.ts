import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// Intentionally writes to tracked docs/pr-screenshots for PR evidence (product requirement).
const screenshotDir = resolve(process.cwd(), 'docs/pr-screenshots')

test.describe('PR screenshot — logs original error', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/private/sso/check-enforcement', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
  })

  test('capture observe logs translated name and hover key', async ({ page }) => {
    mkdirSync(screenshotDir, { recursive: true })
    const originalError = 'Uncaught ReferenceError: foo is not defined'
    const now = new Date().toISOString()

    await page.route('**/private/stats', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            app_id: 'com.demo.app',
            device_id: '44444444-4444-4444-4444-444444444444',
            action: 'webview_javascript_error',
            version_name: '1.0.0',
            created_at: now,
            metadata: {
              error_type: 'javascript_error',
              message: originalError,
              href: 'capacitor://localhost/index.html',
            },
          },
        ]),
      })
    })

    await page.goto('/app/com.demo.app/observe/logs')
    await dismissSupportPrompt(page)

    const row = page.locator('#custom_table tbody tr', { hasText: '44444444' })
    const action = row.locator('[data-test="log-row-action"]')

    await expect(action.locator('[data-test="log-row-action-name"]')).toHaveText('WebView JavaScript error')
    await expect(action.locator('[data-test="log-row-action-key"]')).toBeHidden()
    await expect(row.locator('[data-test="log-row-original-error"]')).toHaveText(originalError)

    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(screenshotDir, 'logs-table-original-error.png'), fullPage: false })
    await row.screenshot({ path: resolve(screenshotDir, 'logs-table-original-error-row.png') })

    await action.hover()
    await expect(action.locator('[data-test="log-row-action-name"]')).toBeHidden()
    await expect(action.locator('[data-test="log-row-action-key"]')).toHaveText('webview_javascript_error')

    await page.screenshot({ path: resolve(screenshotDir, 'logs-table-action-hover-key.png'), fullPage: false })
    await row.screenshot({ path: resolve(screenshotDir, 'logs-table-action-hover-key-row.png') })
  })
})
