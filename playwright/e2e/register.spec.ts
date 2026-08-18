import type { Page } from '@playwright/test'
import { expect, test } from '../support/commands'

async function loginToOnboarding(page: Page, email: string, password: string) {
  await page.login(email, password, /\/onboarding\/app/)
}

async function continuePastWelcome(page: Page) {
  const continueButton = page.locator('[data-test="onboarding-welcome-continue"]')
  await expect(continueButton).toBeVisible()
  await continueButton.click()
}

async function expectProtectedRouteRedirect(page: Page, targetPath: string, expectedUrl: RegExp, expectedSelector: string) {
  const redirectedPage = await page.context().newPage()

  try {
    await redirectedPage.goto(targetPath, { waitUntil: 'commit' })
    await redirectedPage.waitForURL(expectedUrl)
    await expect(redirectedPage.locator(expectedSelector)).toBeVisible()
  }
  finally {
    await redirectedPage.close()
  }
}

async function continueFromAppNameToIcon(page: Page) {
  await page.click('[data-test="app-onboarding-continue"]')
  await expect(page.locator('#app-onboarding-app-id')).toBeVisible()
  await page.click('[data-test="app-onboarding-skip-app-id"]')
  await expect(page.locator('[data-test="app-onboarding-toggle-icon-store-import"]')).toBeVisible()
}

async function continueFromAppNameToOrganization(page: Page) {
  await continueFromAppNameToIcon(page)
  await page.click('[data-test="app-onboarding-continue"]')
}

async function returnFromOrganizationToAppName(page: Page) {
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-test="app-onboarding-toggle-icon-store-import"]')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('#app-onboarding-app-id')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
}

test.describe('Registration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/register/')
  })

  test('should redirect new users through app-first onboarding until the org is created', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `no-org-e2e-${uniqueSuffix}@example.com`
    const appName = `No Org App ${uniqueSuffix}`
    const editedAppName = `Renamed App ${uniqueSuffix}`
    const finalAppName = `Final App ${uniqueSuffix}`
    const organizationName = `Manual Org ${uniqueSuffix}`

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="first_name"]', 'No')
    await page.fill('[data-test="last_name"]', 'Org')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await continuePastWelcome(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')

    await expect(page.locator('[data-test="app-onboarding-existing-yes"]')).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-existing-no"]')).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
    await expect(page.locator('#app-onboarding-app-id')).toHaveCount(0)
    await page.fill('[data-test="app-onboarding-name"]', appName)
    await continueFromAppNameToOrganization(page)

    await expectProtectedRouteRedirect(page, '/apps', /\/onboarding\/app/, '[data-test="onboarding-logout"]')

    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveValue(appName)
    await page.locator('[data-test="onboarding-estimated-users-option"]').nth(1).click()
    await returnFromOrganizationToAppName(page)
    await page.fill('[data-test="app-onboarding-name"]', editedAppName)
    await continueFromAppNameToOrganization(page)
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveValue(editedAppName)
    await page.fill('[data-test="onboarding-org-name"]', organizationName)
    await returnFromOrganizationToAppName(page)
    await page.fill('[data-test="app-onboarding-name"]', finalAppName)
    await continueFromAppNameToOrganization(page)
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveValue(organizationName)
    await expect(page.locator('[data-test="onboarding-create-org"]')).toBeEnabled()
    await page.click('[data-test="onboarding-create-org"]')

    await expect(page.locator('[data-test="onboarding-invite-users"]')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('[data-test="app-onboarding-command-copy"]')).toHaveCount(0)
    await page.click('[data-test="onboarding-finish"]')

    await expect(page.locator('[data-test="app-onboarding-command-copy"]')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('[data-test="onboarding-technical-invite"]')).toBeVisible()
    await expect(page).toHaveURL(/\/onboarding\/app/)
  })

  test('should offer to continue or restart onboarding after a dropout', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `onboarding-resume-e2e-${uniqueSuffix}@example.com`
    const appName = `Resume App ${uniqueSuffix}`
    const password = 'Password123!'

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="first_name"]', 'Resume')
    await page.fill('[data-test="last_name"]', 'User')
    await page.fill('[data-test="password"]', password)
    await page.fill('[data-test="confirm-password"]', password)
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await continuePastWelcome(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await page.fill('[data-test="app-onboarding-name"]', appName)
    await continueFromAppNameToIcon(page)
    await Promise.all([
      page.waitForResponse((response) => {
        if (!response.url().includes('/rest/v1/users') || response.request().method() !== 'PATCH' || !response.ok())
          return false
        return (response.request().postData() ?? '').includes('"step":"organization"')
      }),
      page.click('[data-test="app-onboarding-continue"]'),
    ])
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveValue(appName)

    await page.click('[data-test="onboarding-logout"]')
    await page.waitForURL(/\/login\/?$/)
    await loginToOnboarding(page, email, password)

    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toBeVisible()
    await page.locator('[data-test="onboarding-resume-continue"]').click()
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveValue(appName)

    await page.click('[data-test="onboarding-logout"]')
    await page.waitForURL(/\/login\/?$/)
    await loginToOnboarding(page, email, password)
    await expect(page.locator('[data-test="onboarding-resume-restart"]')).toBeVisible()
    await page.locator('[data-test="onboarding-resume-restart"]').click()
    await continuePastWelcome(page)
    await expect(page.locator('[data-test="onboarding-intent-ota"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveCount(0)
  })

  test('should allow new users to log out from org onboarding', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `no-org-logout-e2e-${uniqueSuffix}@example.com`

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="first_name"]', 'Wrong')
    await page.fill('[data-test="last_name"]', 'Account')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await page.click('[data-test="onboarding-logout"]')

    await page.waitForURL(/\/login\/?$/)
    await expectProtectedRouteRedirect(page, '/apps', /\/login/, '[data-test="continue"]')
  })

  test('should show error for existing email', async ({ page }) => {
    await page.fill('[data-test="email"]', 'test@capgo.app')
    await page.fill('[data-test="first_name"]', 'Test')
    await page.fill('[data-test="last_name"]', 'User')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('User already registered')
  })

  test('should show error for deleted account email', async ({ page }) => {
    await page.fill('[data-test="email"]', 'deleted@capgo.app')
    await page.fill('[data-test="first_name"]', 'Test')
    await page.fill('[data-test="last_name"]', 'User')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Account with this email used to exist, cannot recreate')
  })

  test('should show error for password mismatch', async ({ page }) => {
    await page.fill('[data-test="email"]', 'new@example.com')
    await page.fill('[data-test="first_name"]', 'Test')
    await page.fill('[data-test="last_name"]', 'User')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password456!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('.formkit-messages [data-message-type="validation"]')).toContainText('Password confirmation does not match')
  })
})
