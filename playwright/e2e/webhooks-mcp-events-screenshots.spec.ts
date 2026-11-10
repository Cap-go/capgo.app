import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), '.context/playwright-screenshots/mcp-webhooks')

const DEMO_ORG_ID = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const DEMO_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'

const consoleWebhookOnly = [
  {
    id: 'd7820000-0000-4000-8000-0000000000a1',
    org_id: DEMO_ORG_ID,
    name: 'CI bundle audit',
    url: 'https://hooks.example.com/capgo/console/demo',
    enabled: true,
    events: ['app_versions'],
    delivery_version: 'standard',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: DEMO_USER_ID,
    source: 'console',
    expires_at: null,
    mcp_event: null,
    mcp_arguments: null,
    mcp_verified_at: null,
  },
]

async function stubConsoleOnlyWebhooks(page: import('@playwright/test').Page) {
  await page.route(/webhooks(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET' || route.request().url().includes('deliveries'))
      return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(consoleWebhookOnly),
    })
  })
}

async function openWebhooksList(page: import('@playwright/test').Page) {
  await page.goto('/settings/organization/webhooks/')
  await page.getByRole('heading', { name: 'Webhooks', exact: true }).waitFor({ timeout: 60000 })
}

test.describe('Webhooks MCP badge screenshots', () => {
  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
    await dismissSupportPrompt(page)
  })

  test('desktop before and after MCP badge', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await stubConsoleOnlyWebhooks(page)
    await openWebhooksList(page)
    await expect(page.getByText('MCP', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: resolve(screenshotDir, 'desktop-before.png'), fullPage: true })

    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await openWebhooksList(page)
    await expect(page.getByText('MCP', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: resolve(screenshotDir, 'desktop-after.png'), fullPage: true })
  })

  test('mobile before and after MCP badge', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await stubConsoleOnlyWebhooks(page)
    await openWebhooksList(page)
    await expect(page.getByText('MCP', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: resolve(screenshotDir, 'mobile-before.png'), fullPage: true })

    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await openWebhooksList(page)
    await expect(page.getByText('MCP', { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: resolve(screenshotDir, 'mobile-after.png'), fullPage: true })
  })
})
