import { expect, test } from '../support/commands'

test.describe('SSO Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login/')
  })

  test('should show email and password on first paint', async ({ page }) => {
    await expect(page.locator('[data-test="email"]')).toBeVisible()
    await expect(page.locator('[data-test="password"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeVisible()
    await expect(page.locator('[data-test="sso-login"]')).toHaveCount(0)
  })

  test('should keep password visible for non-SSO domains', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: false }),
      })
    })

    await page.fill('[data-test="email"]', 'test@example.com')
    await expect(page.locator('[data-test="password"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeVisible()
    await expect(page.locator('[data-test="sso-login"]')).toHaveCount(0)
  })

  test('should show optional SSO without hiding password', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true, enforce_sso: false }),
      })
    })

    await page.fill('[data-test="email"]', 'user@optional-sso.example')
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-test="password"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeVisible()
  })

  test('should hide password when SSO is enforced', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true, enforce_sso: true }),
      })
    })

    await page.fill('[data-test="email"]', 'user@enforced-sso.example')
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-test="password"]')).toBeHidden()
    await expect(page.locator('[data-test="submit"]')).toBeHidden()
  })

  test('should keep email editable on mobile when SSO is enforced', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true, enforce_sso: true }),
      })
    })

    const longEmail = 'avery.long.email.address.with-many-segments@very-long-example-domain-for-mobile-testing.example.com'
    await page.fill('[data-test="email"]', longEmail)
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-test="email"]')).toHaveValue(longEmail)
    await expect(page.locator('[data-test="email"]')).toBeEditable()
  })
})
