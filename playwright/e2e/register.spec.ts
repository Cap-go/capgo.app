import type { Page } from '@playwright/test'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseWorktreeConfig } from '../../scripts/supabase-worktree-config'
import { expect, test } from '../support/commands'

const { ports: supabasePorts } = getSupabaseWorktreeConfig()
const localSupabaseUrl = `http://127.0.0.1:${supabasePorts.api}`
const localSupabaseAnonKey = env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

async function loginToOnboarding(page: Page, email: string, password: string) {
  await page.login(email, password, /\/onboarding\/app/)
}

async function continuePastWelcome(page: Page) {
  const continueButton = page.locator('[data-test="onboarding-welcome-continue"]')
  await expect(continueButton).toBeVisible()
  await continueButton.click()
}

async function continuePastDevelopmentEnvironmentIfShown(page: Page) {
  const assistantOption = page.locator('[data-test="onboarding-development-environment-ai_assistant"]')
  const appNameInput = page.locator('[data-test="app-onboarding-name"]')
  await expect(assistantOption.or(appNameInput)).toBeVisible()
  if (await assistantOption.isVisible()) {
    await assistantOption.click()
    await page.click('[data-test="app-onboarding-continue-development-environment"]')
  }
}

async function continuePastChannelOnboardingIfShown(page: Page) {
  const cliSetup = page.locator('[data-test="onboarding-setup-cli"]')
  const routingContinue = page.locator('[data-test="channel-default-routing-continue"]')
  await expect(routingContinue.or(cliSetup)).toBeVisible({ timeout: 60000 })
  if (!await routingContinue.isVisible())
    return

  await routingContinue.click()
  await page.locator('[data-test="channel-self-assign-continue"]').click()
  await page.locator('[data-test="channel-console-assign-continue"]').click()

  const createChannel = page.locator('[data-test="channel-create-submit"]')
  const continueAfterChannel = page.locator('[data-test="channel-create-continue"]')
  await expect(createChannel.or(continueAfterChannel)).toBeVisible()
  if (await createChannel.isVisible()) {
    await page.locator('[data-test="channel-create-name"]').fill('production')
    await createChannel.click()
    await expect(continueAfterChannel).toBeVisible()
  }
  await continueAfterChannel.click()
  await expect(cliSetup).toBeVisible()
}

async function forceWebNativeOnboardingTreatments(email: string, password: string) {
  const supabase = createClient(localSupabaseUrl, localSupabaseAnonKey)
  const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
  if (signInError || !sessionData.user)
    throw signInError ?? new Error('Cannot sign in treatment user')

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('onboarding')
    .eq('id', sessionData.user.id)
    .single()
  if (profileError)
    throw profileError

  const onboarding = profile.onboarding && typeof profile.onboarding === 'object' && !Array.isArray(profile.onboarding)
    ? profile.onboarding
    : {}
  const abtests = onboarding.abtests && typeof onboarding.abtests === 'object' && !Array.isArray(onboarding.abtests)
    ? onboarding.abtests
    : {}
  const { error: updateError } = await supabase
    .from('users')
    .update({
      onboarding: {
        ...onboarding,
        abtests: {
          ...abtests,
          webnativeapp_publish_intent: {
            assigned_at: new Date().toISOString(),
            branch: 'A',
          },
          webnativeapp_development_environment: {
            assigned_at: new Date().toISOString(),
            branch: 'C',
          },
        },
      },
    })
    .eq('id', sessionData.user.id)
  if (updateError)
    throw updateError

  await supabase.auth.signOut()
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

    await expect(page.locator('[data-test="first_name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="last_name"]')).toHaveCount(0)
    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await continuePastWelcome(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    const continueGoal = page.locator('[data-test="app-onboarding-continue-intent"]')
    await expect(continueGoal).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible()
    await expect(page.locator('[data-test="onboarding-last-name"]')).toBeVisible()
    await page.fill('[data-test="onboarding-first-name"]', '   ')
    await expect(continueGoal).toBeDisabled()
    await page.fill('[data-test="onboarding-first-name"]', '  Example  ')
    await page.fill('[data-test="onboarding-last-name"]', '   ')
    await expect(continueGoal).toBeDisabled()
    await page.fill('[data-test="onboarding-last-name"]', '  User  ')
    await expect(continueGoal).toBeEnabled()

    await page.route('**/rest/v1/users?*', async (route) => {
      if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.first_name) {
        await route.fulfill({ status: 500, json: { message: 'Test profile save failure' } })
        return
      }
      await route.fallback()
    })
    await continueGoal.click()
    await expect(page.getByText('Error while updating your account', { exact: true })).toBeVisible()
    await expect(page.locator('[data-test="onboarding-intent-ota"]')).toBeVisible()
    await expect(page.locator('[data-test="app-onboarding-name"]')).toHaveCount(0)
    await page.unroute('**/rest/v1/users?*')
    await continueGoal.click()
    await continuePastDevelopmentEnvironmentIfShown(page)

    const supabase = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({ email, password: 'Password123!' })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await supabase.from('users')
      .select('first_name, last_name')
      .eq('id', signedIn.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'User' })
    await supabase.auth.signOut()

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
    const createOrganization = page.locator('[data-test="onboarding-create-org"]')
    await expect(createOrganization).toBeEnabled()
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveCount(0)
    await createOrganization.click()

    await expect(page.locator('[data-test="onboarding-invite-users"]')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)

    await expect(page.locator('[data-test="app-onboarding-command-copy"]')).toHaveCount(0)
    await page.click('[data-test="onboarding-finish"]')

    await continuePastChannelOnboardingIfShown(page)
    await expect(page.locator('[data-test="onboarding-technical-invite"]')).toBeVisible()
    await expect(page).toHaveURL(/\/app\/[^/]+\/getting-started$/)
  })

  test('should collect first and last names before the goal on the About you step on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.fill('[data-test="email"]', `mobile-profile-e2e-${Date.now()}@example.com`)
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await page.waitForURL(/\/onboarding\/app/)

    await expect(page.locator('[data-test="onboarding-welcome-continue"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-first-name"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-last-name"]')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible()
    const nameBox = await page.locator('[data-test="onboarding-first-name"]').boundingBox()
    const surnameBox = await page.locator('[data-test="onboarding-last-name"]').boundingBox()
    const goalBox = await page.getByRole('heading', { name: 'What would you like to do with Capgo?', exact: true }).boundingBox()
    expect(nameBox).not.toBeNull()
    expect(surnameBox).not.toBeNull()
    expect(goalBox).not.toBeNull()
    expect(nameBox!.y + nameBox!.height).toBeLessThan(goalBox!.y)
    expect(surnameBox!.y + surnameBox!.height).toBeLessThan(goalBox!.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.fill('[data-test="onboarding-first-name"]', 'Example')
    await page.fill('[data-test="onboarding-last-name"]', 'User')
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
  })

  test('should complete a partial profile and skip both names for subsequent organizations', async ({ page }) => {
    const email = `partial-profile-e2e-${Date.now()}@example.com`
    const password = 'Password123!'
    const supabase = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedUp, error: signUpError } = await supabase.auth.signUp({ email, password })
    expect(signUpError).toBeNull()
    const { data: seededProfile, error: updateError } = await supabase.from('users')
      .upsert({ id: signedUp.user!.id, email, first_name: 'Example', last_name: '' }, { onConflict: 'id' })
      .select('first_name, last_name')
      .single()
    expect(updateError).toBeNull()
    expect(seededProfile).toEqual({ first_name: 'Example', last_name: '' })
    await supabase.auth.signOut()

    await loginToOnboarding(page, email, password)
    await continuePastWelcome(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveValue('Example')
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('')
    await expect(page.locator('[data-test="app-onboarding-continue-intent"]')).toBeDisabled()
    await page.fill('[data-test="onboarding-last-name"]', '  User  ')
    await expect(page.locator('[data-test="app-onboarding-continue-intent"]')).toBeEnabled()
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)

    await page.goto('/onboarding/organization?source=org-switcher')
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="onboarding-mode-name"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveCount(0)
    await page.fill('[data-test="onboarding-org-name"]', `Profile Org ${Date.now()}`)
    await page.locator('[data-test="onboarding-estimated-users-option"]').first().click()
    const createOrganization = page.locator('[data-test="onboarding-create-org"]')
    await expect(createOrganization).toBeEnabled()
    await createOrganization.click()
    await expect(page.locator('[data-test="onboarding-logo-action"]')).toBeVisible({ timeout: 60000 })

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await supabase.from('users')
      .select('first_name, last_name')
      .eq('id', signedUp.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'User' })
    await supabase.auth.signOut()

    await page.goto('/onboarding/organization?source=org-switcher')
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="onboarding-mode-name"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveCount(0)
  })

  test('should preserve an existing surname when saving the first name', async ({ page }) => {
    const email = `surname-profile-e2e-${Date.now()}@example.com`
    const password = 'Password123!'
    const supabase = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedUp, error: signUpError } = await supabase.auth.signUp({ email, password })
    expect(signUpError).toBeNull()
    const { error: updateError } = await supabase.from('users')
      .upsert({ id: signedUp.user!.id, email, first_name: '', last_name: 'Existing' }, { onConflict: 'id' })
    expect(updateError).toBeNull()
    await supabase.auth.signOut()

    await loginToOnboarding(page, email, password)
    await continuePastWelcome(page)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('Existing')
    await page.fill('[data-test="onboarding-first-name"]', '  Example  ')
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await supabase.from('users')
      .select('first_name, last_name')
      .eq('id', signedUp.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'Existing' })
    await supabase.auth.signOut()
  })

  test('should offer to continue or restart onboarding after a dropout', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `onboarding-resume-e2e-${uniqueSuffix}@example.com`
    const appName = `Resume App ${uniqueSuffix}`
    const password = 'Password123!'

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="password"]', password)
    await page.fill('[data-test="confirm-password"]', password)
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await continuePastWelcome(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.fill('[data-test="onboarding-first-name"]', 'Example')
    await page.fill('[data-test="onboarding-last-name"]', 'User')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)
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
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveCount(0)
  })

  test('should recommend WebNativeApp to treatment users publishing without existing users', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `webnative-treatment-e2e-${uniqueSuffix}@example.com`
    const password = 'Password123!'
    const appName = `WebNative Treatment ${uniqueSuffix}`

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="password"]', password)
    await page.fill('[data-test="confirm-password"]', password)
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await expect(page.locator('[data-test="onboarding-welcome-continue"]')).toBeVisible()
    await forceWebNativeOnboardingTreatments(email, password)
    await page.reload()
    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toBeVisible()
    await page.locator('[data-test="onboarding-resume-continue"]').click()

    await expect(page.locator('[data-test="onboarding-intent-publish"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-development-environment-hosted_builder"]')).toHaveCount(0)
    await page.click('[data-test="onboarding-intent-publish"]')
    await page.fill('[data-test="onboarding-first-name"]', 'Example')
    await page.fill('[data-test="onboarding-last-name"]', 'User')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await expect(page.locator('[data-test="onboarding-development-environment-hosted_builder"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-intent-publish"]')).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-skip-development-environment"]')).toBeVisible()
    await expect(page.locator('[data-test="app-onboarding-continue-development-environment"]')).toHaveCount(0)
    await page.click('[data-test="onboarding-development-environment-hosted_builder"]')
    await expect(page.locator('[data-test="app-onboarding-continue-development-environment"]')).toBeVisible()
    await page.click('[data-test="app-onboarding-continue-development-environment"]')
    await page.fill('[data-test="app-onboarding-name"]', appName)
    await continueFromAppNameToOrganization(page)

    await page.locator('[data-test="onboarding-starting-out"]').click()
    await expect(page.locator('[data-test="onboarding-webnative-recommendation"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-webnative-check-website"]')).toHaveAttribute('href', 'https://webnativeapp.com/?ref=capgo')
    await expect(page.locator('[data-test="onboarding-create-org"]')).toHaveCount(0)

    await page.click('[data-test="onboarding-webnative-continue-capgo"]')
    await expect(page.locator('[data-test="onboarding-webnative-recommendation"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-create-org"]')).toBeEnabled()
  })

  test('should allow new users to log out from org onboarding', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `no-org-logout-e2e-${uniqueSuffix}@example.com`

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/app/)
    await page.click('[data-test="onboarding-logout"]')

    await page.waitForURL(/\/login\/?$/)
    await expectProtectedRouteRedirect(page, '/apps', /\/login/, '[data-test="email"]')
  })

  test('should show error for existing email', async ({ page }) => {
    await page.fill('[data-test="email"]', 'test@capgo.app')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('User already registered')
  })

  test('should show error for deleted account email', async ({ page }) => {
    await page.fill('[data-test="email"]', 'deleted@capgo.app')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Account with this email used to exist, cannot recreate')
  })

  test('should show error for password mismatch', async ({ page }) => {
    await page.fill('[data-test="email"]', 'new@example.com')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.fill('[data-test="confirm-password"]', 'Password456!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('.formkit-messages [data-message-type="validation"]')).toContainText('Password confirmation does not match')
  })
})
