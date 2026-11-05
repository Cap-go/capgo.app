import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/screenshots/apikeys-secure-col')
const phase = process.env.CAPGO_PR_SCREENSHOT_PHASE === 'before' ? 'before' : 'after'

const now = '2026-10-21T12:00:00.000Z'
const demoOrgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const hashedRbacId = '11111111-1111-4111-8111-111111111101'
const plainRbacId = '11111111-1111-4111-8111-111111111102'
const orgSuperAdminRoleId = '00000000-0000-4000-8000-000000000001'

async function dismissOptionalPrompts(page: import('@playwright/test').Page) {
  await dismissSupportPrompt(page)
  const remindLater = page.getByRole('button', { name: 'Remind me later', exact: true })
  if (await remindLater.isVisible().catch(() => false))
    await remindLater.click()
}

async function mockApiKeysPage(page: import('@playwright/test').Page) {
  // Keep auth/org/bootstrap real; only pin the keys list so hashed + plain rows are visible.
  await page.route('**/functions/v1/apikey**', async (route) => {
    if (route.request().method() !== 'GET')
      return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 9001,
          created_at: now,
          updated_at: now,
          expires_at: null,
          name: 'CI deploy',
          user_id: '6aa76066-55ef-4238-ade6-0b32334a4097',
          rbac_id: hashedRbacId,
          is_hashed_key: true,
          global_permissions: [],
        },
        {
          id: 9002,
          created_at: '2026-09-12T12:00:00.000Z',
          updated_at: '2026-09-12T12:00:00.000Z',
          expires_at: null,
          name: 'Local CLI',
          user_id: '6aa76066-55ef-4238-ade6-0b32334a4097',
          rbac_id: plainRbacId,
          key: 'abcdefghijklmnopvwxyz',
          is_hashed_key: false,
          global_permissions: [],
        },
      ]),
    })
  })

  await page.route('**/rest/v1/role_bindings**', async (route) => {
    if (route.request().method() !== 'GET')
      return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '22222222-2222-4222-8222-222222222201',
          principal_type: 'apikey',
          principal_id: hashedRbacId,
          scope_type: 'org',
          org_id: demoOrgId,
          app_id: null,
          role_id: orgSuperAdminRoleId,
          roles: { name: 'org_member' },
        },
        {
          id: '22222222-2222-4222-8222-222222222202',
          principal_type: 'apikey',
          principal_id: plainRbacId,
          scope_type: 'org',
          org_id: demoOrgId,
          app_id: null,
          role_id: orgSuperAdminRoleId,
          roles: { name: 'org_admin' },
        },
      ]),
    })
  })
}

// Captures the real /apikeys Vue page (ApiKeys.vue + DataTable), not HTML mockups.
// Local:
//   CAPGO_PR_SCREENSHOTS=1 CAPGO_PR_SCREENSHOT_PHASE=after bunx playwright test playwright/e2e/apikeys-secure-col-screenshots.spec.ts
// For before: temporarily restore the pre-change ApiKeys column renderer, then PHASE=before.
test.describe('API keys secure column screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
  })

  test(`capture ${phase} API keys table`, async ({ page }) => {
    await mockApiKeysPage(page)
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/apikeys')
    await dismissOptionalPrompts(page)

    await expect(page.locator('[data-test="create-key"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('CI deploy')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Local CLI')).toBeVisible({ timeout: 30_000 })

    if (phase === 'before') {
      await expect(page.getByText('Secure key (hidden)').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('abcde...vwxyz')).toBeVisible()
    }
    else {
      await expect(page.getByLabel('Secure key (hidden)').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('abc...xyz')).toBeVisible()
    }

    const table = page.locator('table').first()
    await table.scrollIntoViewIfNeeded()
    await table.screenshot({
      path: resolve(screenshotDir, `${phase}.png`),
      animations: 'disabled',
    })
  })
})
