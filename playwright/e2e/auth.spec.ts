import { expect, test } from '../support/commands'

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login/')
  })

  test('should keep the password field in the form but hidden until the domain is known', async ({ page }) => {
    await expect(page.locator('[data-test="email"]')).toBeVisible()
    await expect(page.locator('[data-test="submit"]')).toBeHidden()
    await expect(page.locator('[data-test="sso-login"]')).toHaveCount(0)
    await expect(page.locator('[data-test="password"]')).toHaveCount(1)
    await expect(page.locator('[data-password-ready="false"]')).toHaveCount(1)
    await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveCount(1)
  })

  test('should show error for invalid credentials', async ({ page }) => {
    await page.fill('[data-test="email"]', 'wrong@example.com')
    await expect(page.locator('[data-test="submit"]')).toBeVisible({ timeout: 10000 })
    await page.fill('[data-test="password"]', 'wrongpass')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Invalid login credentials')
  })

  test('should show error for deleted account', async ({ page }) => {
    await page.fill('[data-test="email"]', 'deleted@capgo.app')
    await expect(page.locator('[data-test="submit"]')).toBeVisible({ timeout: 10000 })
    await page.fill('[data-test="password"]', 'password')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Account with this email used to exist, cannot recreate')
  })

  test('should login successfully and redirect', async ({ page }) => {
    await page.fill('[data-test="email"]', 'test@capgo.app')
    await expect(page.locator('[data-test="submit"]')).toBeVisible({ timeout: 10000 })
    await page.fill('[data-test="password"]', 'testtest')
    await page.click('[data-test="submit"]')
    await page.waitForURL(/\/(apps|dashboard)(\/|$)/)
  })

  test('should keep email when navigating to forgot password page', async ({ page }) => {
    const email = 'test@capgo.app'
    await page.fill('[data-test="email"]', email)
    await expect(page.locator('[data-test="forgot-password"]')).toBeVisible({ timeout: 10000 })
    await page.click('[data-test="forgot-password"]')
    await expect(page).toHaveURL('/forgot_password')
    await expect(page.locator('[data-test="email"]')).toHaveValue(email)
  })

  test('should navigate to registration page', async ({ page }) => {
    await page.click('[data-test="register"]')
    await expect(page).toHaveURL('/register/')
  })
})

test.describe('Password Reset', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/forgot_password/')
  })

  test('should show success message after password reset request', async ({ page }) => {
    await page.fill('[data-test="email"]', 'test@capgo.app')
    await page.waitForSelector('[data-test="submit"]:not([disabled])')
    await page.click('[data-test="submit"]')
    const toast = page.locator('[data-test="toast"]')
    await expect(toast).toContainText('Check your email to get the link to reset your password')
  })
})
