import { expect, test } from '@playwright/test'

test.describe('Webhooks MCP badge screenshots', () => {
  test('desktop webhooks page shows MCP subscriptions', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/settings/organization/webhooks')
    await page.getByRole('heading', { name: 'Webhooks', exact: true }).waitFor()
    await expect(page.getByText('MCP', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: 'playwright/screenshots/webhooks-mcp-desktop-after.png', fullPage: true })
  })

  test('mobile webhooks page shows MCP subscriptions', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/settings/organization/webhooks')
    await page.getByRole('heading', { name: 'Webhooks', exact: true }).waitFor()
    await expect(page.getByText('MCP', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: 'playwright/screenshots/webhooks-mcp-mobile-after.png', fullPage: true })
  })
})
