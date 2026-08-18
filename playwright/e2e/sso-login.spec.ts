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

    const domainCheck = page.waitForResponse(response => response.url().includes('/private/sso/check-domain'))
    await page.fill('[data-test="email"]', 'test@example.com')
    await domainCheck
    await expect(page.locator('[data-test="password"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeVisible()
    await expect(page.locator('[data-test="sso-login"]')).toHaveCount(0)
  })

  test('should use SSO only when the domain has SSO', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true, enforce_sso: false }),
      })
    })

    await page.fill('[data-test="email"]', 'user@sso.example')
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-test="password"]')).toBeHidden()
    await expect(page.locator('[data-test="submit"]')).toBeHidden()
  })

  test('should keep email editable on mobile when SSO is required', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true }),
      })
    })

    const longEmail = 'avery.long.email.address.with-many-segments@very-long-example-domain-for-mobile-testing.example.com'
    await page.fill('[data-test="email"]', longEmail)
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-test="email"]')).toHaveValue(longEmail)
    await expect(page.locator('[data-test="email"]')).toBeEditable()
  })
})
