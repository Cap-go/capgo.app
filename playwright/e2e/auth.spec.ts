import type { Page } from '@playwright/test'
import { expect, test } from '../support/commands'

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login/')
  })

  async function continueToPasswordStep(page: Page, email: string) {
    await page.fill('[data-test="email"]', email)
    await page.click('[data-test="continue"]')
    await page.waitForSelector('[data-test="password"]')
  }

  test('should show loading state during domain check', async ({ page }) => {
    await page.route('**/private/sso/check-domain', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 500))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_sso: false }),
      })
    })

    await page.fill('[data-test="email"]', 'test@capgo.app')
    await page.click('[data-test="continue"]')
    await expect(page.locator('[data-test="loading"]')).toBeVisible()
    await expect(page.locator('[data-test="password"]')).toBeVisible()
  })

  test('should show error for invalid credentials', async ({ page }) => {
    await continueToPasswordStep(page, 'wrong@example.com')
    await page.fill('[data-test="password"]', 'wrongpass')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Invalid login credentials')
  })

  test('should show error for deleted account', async ({ page }) => {
    await continueToPasswordStep(page, 'deleted@capgo.app')
    await page.fill('[data-test="password"]', 'password')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Account with this email used to exist, cannot recreate')
  })

  test('should login successfully and redirect', async ({ page }) => {
    await continueToPasswordStep(page, 'test@capgo.app')
    await page.fill('[data-test="password"]', 'testtest')
    await page.click('[data-test="submit"]')
    await page.waitForURL(/\/(apps|dashboard)(\/|$)/)
  })

  test('should keep email when navigating to forgot password page', async ({ page }) => {
    const email = 'test@capgo.app'
    await continueToPasswordStep(page, email)
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
