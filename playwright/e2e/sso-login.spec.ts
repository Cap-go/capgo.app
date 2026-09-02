import { expect, test } from '../support/commands'

test.describe('SSO Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login/')
  })

  test('should show email only on first paint', async ({ page }) => {
    await expect(page.locator('[data-test="email"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeHidden()
    await expect(page.locator('[data-test="sso-login"]')).toHaveCount(0)
    await expect(page.locator('[data-test="password"]')).toHaveCount(1)
    await expect(page.locator('[data-password-ready="false"]')).toHaveCount(1)
  })

  test('should reveal password for non-SSO domains', async ({ page }) => {
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
    await expect(page.locator('[data-password-ready="true"]')).toHaveCount(1)
    await expect(page.locator('[data-test="password"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeVisible()
    await expect(page.locator('[data-test="sso-login"]')).toHaveCount(0)
  })

  test('should retry an unsuccessful domain check on submit', async ({ page }) => {
    let checks = 0
    await page.route('**/private/sso/check-domain', async (route) => {
      checks += 1
      if (checks === 1) {
        await route.fulfill({ status: 500, body: 'error' })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true }),
      })
    })

    await page.fill('[data-test="email"]', 'user@sso.example')
    await expect(page.locator('[data-password-ready="true"]')).toHaveCount(1)
    await page.fill('[data-test="password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect.poll(() => checks).toBeGreaterThan(1)
  })

  test('should keep password login when SSO is available but not enforced', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true, enforce_sso: false }),
      })
    })

    await page.fill('[data-test="email"]', 'user@sso.example')
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-password-ready="true"]')).toHaveCount(1)
    await expect(page.locator('[data-test="password"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeVisible()
  })

  test('should hide password login when SSO is enforced', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: true, enforce_sso: true }),
      })
    })

    await page.fill('[data-test="email"]', 'user@sso.example')
    await expect(page.locator('[data-test="sso-login"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-password-ready="false"]')).toHaveCount(1)
    await expect(page.locator('[data-test="submit"]')).toBeHidden()
  })

  test('should keep email editable on mobile when the domain has SSO', async ({ page }) => {
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
