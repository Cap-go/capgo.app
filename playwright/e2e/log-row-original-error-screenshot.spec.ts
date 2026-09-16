import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// Intentionally writes to tracked docs/pr-screenshots for PR evidence (product requirement).
const screenshotDir = resolve(process.cwd(), 'docs/pr-screenshots')

test.describe('PR screenshot — logs original error', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('capgo-log-action-label-mode', 'name')
    })
    await page.login('test@capgo.app', 'testtest')
  })

  test('capture observe logs in name and key action label modes', async ({ page }) => {
    mkdirSync(screenshotDir, { recursive: true })

    await page.goto('/app/com.demo.app/observe/logs')
    await dismissSupportPrompt(page)

    const row = page.locator('#custom_table tbody tr', { hasText: '44444444' })
    await expect(page.locator('[data-test="log-action-label-mode-name"]')).toHaveAttribute('aria-pressed', 'true')

    await expect(row.locator('[data-test="log-row-action"]')).toHaveText('WebView JavaScript error')
    await expect(row.locator('[data-test="log-row-action-code"]')).toHaveText('webview_javascript_error')
    await expect(row.locator('[data-test="log-row-original-error"]')).toHaveText('Uncaught ReferenceError: foo is not defined')

    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(screenshotDir, 'logs-table-action-label-name-mode.png'), fullPage: false })
    await row.screenshot({ path: resolve(screenshotDir, 'logs-table-action-label-name-mode-row.png') })

    await page.locator('[data-test="log-action-label-mode-key"]').click()
    await expect(page.locator('[data-test="log-action-label-mode-key"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(row.locator('[data-test="log-row-action"]')).toHaveText('webview_javascript_error')
    await expect(row.locator('[data-test="log-row-action-code"]')).toHaveCount(0)
    await expect(row.locator('[data-test="log-row-original-error"]')).toHaveText('Uncaught ReferenceError: foo is not defined')

    await row.scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(screenshotDir, 'logs-table-action-label-key-mode.png'), fullPage: false })
    await row.screenshot({ path: resolve(screenshotDir, 'logs-table-action-label-key-mode-row.png') })

    await expect(row.locator('[data-test="log-row-action"]')).toHaveAttribute(
      'title',
      /webview_javascript_error/,
    )
  })
})
