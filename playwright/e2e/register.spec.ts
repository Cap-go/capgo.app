import type { Page } from '@playwright/test'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseWorktreeConfig } from '../../scripts/supabase-worktree-config'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { expect, test } from '../support/commands'
import { CONSOLE_QUERY_ROUTE, consoleQueryError, consoleQueryFromResponse, consoleQueryMethod, consoleQueryPayload, parseConsoleQuery, routeConsoleQuery } from '../support/consoleQuery'

const { ports: supabasePorts } = getSupabaseWorktreeConfig()
const localSupabaseUrl = `http://127.0.0.1:${supabasePorts.api}`
const localSupabaseAnonKey = env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

function localAdminClient() {
  const configured = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const status = configured ? null : getSupabaseStatus()
  const key = configured || status?.SERVICE_ROLE_KEY || status?.SECRET_KEY
  if (!key)
    throw new Error('Local Supabase service key is required for registration fixtures')
  return createClient(localSupabaseUrl, key, { auth: { persistSession: false } })
}

async function loginToOnboarding(page: Page, email: string, password: string) {
  await page.login(email, password, /\/onboarding\/(?:name|app)/)
  if (new URL(page.url()).pathname === '/onboarding/name')
    await continuePastProfileWelcome(page)
}

async function continuePastProfileWelcome(page: Page) {
  const welcome = page.locator('[data-test="onboarding-welcome-continue"]')
  const name = page.locator('[data-test="onboarding-name-step"]')
  const resume = page.locator('[data-test="onboarding-resume-continue"]')
  await expect(welcome.or(name).or(resume)).toBeVisible()
  if (await resume.isVisible())
    await resume.click()
  await expect(welcome.or(name)).toBeVisible()
  if (await welcome.isVisible()) {
    await expect(name).toHaveCount(0)
    await welcome.click()
  }
  await expect(name).toBeVisible()
  await expect(page.locator('[data-test="onboarding-name-restart"]')).toHaveCount(0)
}

async function completeName(page: Page) {
  await continuePastProfileWelcome(page)
  await page.fill('[data-test="onboarding-first-name"]', 'Example')
  await page.fill('[data-test="onboarding-last-name"]', 'User')
  await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
  await page.click('[data-test="onboarding-name-continue"]')
  await page.waitForURL(/\/onboarding\/app/)
}

async function expectOnboardingGoal(page: Page) {
  await expect(page.locator('[data-test="onboarding-intent-ota"]')).toBeVisible()
  await expect(page.locator('[data-test="onboarding-welcome-continue"]')).toHaveCount(0)
  await expect(page.locator('nav[aria-label="Onboarding progress"] [aria-current="step"]')).toContainText('Your goal')
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
  const capgo = createClient(localSupabaseUrl, localSupabaseAnonKey)
  const { data: sessionData, error: signInError } = await capgo.auth.signInWithPassword({ email, password })
  if (signInError || !sessionData.user)
    throw signInError ?? new Error('Cannot sign in treatment user')

  // Experiment fixtures use a separate backend client; user sessions cannot
  // override the server-managed assignment fields.
  const configuredServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  const status = configuredServiceKey ? null : getSupabaseStatus()
  const serviceKey = configuredServiceKey || status?.SERVICE_ROLE_KEY || status?.SECRET_KEY
  if (!serviceKey)
    throw new Error('Local Supabase service key is required for treatment fixtures')
  const adminClient = createClient(localSupabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { data: profile, error: profileError } = await adminClient
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
  const { error: updateError } = await adminClient
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

  // End only this helper session; the browser must stay signed in.
  await capgo.auth.signOut({ scope: 'local' })
}

async function expectProtectedRouteRedirect(page: Page, targetPath: string, expectedUrl: RegExp, expectedSelector: string) {
  const redirectedPage = await page.context().newPage()

  try {
    await redirectedPage.goto(targetPath, { waitUntil: 'commit' })
    await redirectedPage.waitForURL(expectedUrl)
    if (new URL(redirectedPage.url()).pathname === '/onboarding/name')
      await continuePastProfileWelcome(redirectedPage)
    await expect(redirectedPage.locator(expectedSelector)).toBeVisible()
  }
  finally {
    await redirectedPage.close()
  }
}

async function continueFromAppNameToIcon(page: Page) {
  await page.click('[data-test="app-onboarding-continue"]')
  await expect(page.locator('[data-test="app-onboarding-toggle-icon-store-import"]')).toBeVisible()
  await expect(page.locator('#app-onboarding-app-id')).toHaveCount(0)
}

async function continueFromAppNameToOrganization(page: Page) {
  await continueFromAppNameToIcon(page)
  await page.click('[data-test="app-onboarding-continue"]')
}

async function returnFromOrganizationToAppName(page: Page) {
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-test="app-onboarding-toggle-icon-store-import"]')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
}

test.describe('Registration', () => {
  test.beforeEach(async ({ page }) => {
    // These tests cover the manual wizard. New users first choose AI or manual setup;
    // the AI path has its own spec (ai-onboarding.spec.ts).
    await page.addLocatorHandler(page.locator('[data-test="onboarding-setup-mode"]'), async () => {
      await page.locator('[data-test="onboarding-setup-mode-manual"]').click()
      await expect(page.locator('[data-test="onboarding-setup-mode"]')).toHaveCount(0)
    })
    await page.goto('/register/')
  })

  test('returns from Your goal to saved names and retains the selected goal', async ({ page }) => {
    await page.fill('[data-test="email"]', `profile-back-${Date.now()}@example.com`)
    await page.fill('[data-test="password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)
    await completeName(page)
    await expectOnboardingGoal(page)
    await page.click('[data-test="onboarding-intent-builder"]')
    await page.click('[data-test="app-onboarding-back-profile"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveValue('Example')
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('User')
    await expect(page.locator('[data-test="onboarding-welcome"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toBeVisible()
    await page.click('[data-test="onboarding-resume-continue"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveValue('Example')
    await page.fill('[data-test="onboarding-first-name"]', '')
    await expect(page.locator('[data-test="onboarding-name-continue"]')).toBeDisabled()
    await page.fill('[data-test="onboarding-first-name"]', 'Updated')
    await page.click('[data-test="onboarding-name-continue"]')
    await expectOnboardingGoal(page)
    await expect(page.locator('[data-test="onboarding-intent-builder"]')).toHaveClass(/(?:^|\s)border-primary-500(?:\s|$)/)
    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toHaveCount(0)
    await page.click('[data-test="app-onboarding-back-profile"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveValue('Updated')
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('User')
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
    await page.route('**/private/console/auth/signup', route => route.abort())
    const registrationRequest = page.waitForRequest(request => request.url().endsWith('/auth/register') && request.method() === 'POST')
    await page.click('[data-test="submit"]')
    const registrationPayload = (await registrationRequest).postDataJSON()
    expect(registrationPayload).not.toHaveProperty('first_name')
    expect(registrationPayload).not.toHaveProperty('last_name')

    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)
    await expectProtectedRouteRedirect(page, '/dashboard', /\/onboarding\/name/, '[data-test="onboarding-name-step"]')
    await routeConsoleQuery(page, 'users', async (route, query) => {
      if (consoleQueryMethod(query) === 'GET') {
        await route.fulfill(consoleQueryError(503, { code: 'unavailable', message: 'Test profile load failure' }))
        return
      }
      await route.fallback()
    })
    await page.reload()
    await expect(page.locator('[data-test="account-load-recovery"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-name-step"]')).toHaveCount(0)
    await page.unroute(CONSOLE_QUERY_ROUTE)
    await page.locator('[data-test="account-load-retry"]').click()
    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)
    await expect(page.locator('[data-test="onboarding-name-step"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-intent-ota"]')).toHaveCount(0)
    const continueGoal = page.locator('[data-test="onboarding-name-continue"]')
    await expect(continueGoal).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible()
    await expect(page.locator('nav[aria-label="Onboarding progress"] [aria-current="step"]')).toContainText('About you')
    await expect(page.getByText('One command. Live on next launch.', { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toBeVisible()
    await page.fill('[data-test="onboarding-first-name"]', '   ')
    await expect(continueGoal).toBeDisabled()
    await page.fill('[data-test="onboarding-first-name"]', '  Example  ')
    await page.fill('[data-test="onboarding-last-name"]', '   ')
    await expect(continueGoal).toBeDisabled()
    await page.fill('[data-test="onboarding-last-name"]', '  User  ')
    await expect(continueGoal).toBeDisabled()
    await page.getByRole('textbox', { name: 'Company name', exact: true }).fill(`  ${organizationName}  `)
    await expect(continueGoal).toBeEnabled()

    await routeConsoleQuery(page, 'users', async (route, query) => {
      if (consoleQueryMethod(query) === 'PATCH' && consoleQueryPayload(query)?.first_name) {
        await route.fulfill(consoleQueryError(500, { message: 'Test profile save failure' }))
        return
      }
      await route.fallback()
    })
    await continueGoal.click()
    await expect(page.getByText('Error while updating your account', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/onboarding\/name/)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toHaveCount(0)
    await page.unroute(CONSOLE_QUERY_ROUTE)
    await continueGoal.click()
    await expectOnboardingGoal(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)

    const capgo = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedIn, error: signInError } = await capgo.auth.signInWithPassword({ email, password: 'Password123!' })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await capgo.from('users')
      .select('first_name, last_name')
      .eq('id', signedIn.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'User' })
    await capgo.auth.signOut({ scope: 'local' })

    await expect(page.locator('[data-test="app-onboarding-existing-yes"]')).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-existing-no"]')).toHaveCount(0)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
    await expect(page.locator('#app-onboarding-app-id')).toHaveCount(0)
    const appNameInput = page.locator('[data-test="app-onboarding-name"]')
    const continueButton = page.locator('[data-test="app-onboarding-continue"]')
    await expect(continueButton).toBeVisible()
    await expect(continueButton).toBeDisabled()
    await appNameInput.fill('   ')
    await expect(continueButton).toBeDisabled()
    await appNameInput.fill(appName)
    await expect(continueButton).toBeEnabled()
    await appNameInput.fill('')
    await expect(continueButton).toBeDisabled()
    await appNameInput.fill('   ')
    await expect(continueButton).toBeDisabled()
    await appNameInput.fill(`  ${appName}  `)
    await expect(continueButton).toBeEnabled()
    await continueFromAppNameToOrganization(page)

    await expectProtectedRouteRedirect(page, '/apps', /\/onboarding\/app/, '[data-test="onboarding-logout"]')

    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-company-name-summary"]')).toHaveText(organizationName)
    await page.locator('[data-test="onboarding-estimated-users-option"]').nth(1).click()
    await returnFromOrganizationToAppName(page)
    await page.fill('[data-test="app-onboarding-name"]', editedAppName)
    await continueFromAppNameToOrganization(page)
    await expect(page.locator('[data-test="onboarding-company-name-summary"]')).toHaveText(organizationName)
    await returnFromOrganizationToAppName(page)
    await page.fill('[data-test="app-onboarding-name"]', finalAppName)
    await continueFromAppNameToOrganization(page)
    await expect(page.locator('[data-test="onboarding-company-name-summary"]')).toHaveText(organizationName)
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
    // New manual signups see one next step, without task counts or the full list.
    await expect(page.locator('[data-test="setup-checklist-instructions"]')).toContainText('Your next step')
    await expect(page.locator('[data-test="setup-checklist-progress"]')).toHaveCount(0)
    await expect(page.locator('[data-test="setup-checklist-toggle"]')).toHaveCount(0)
  })

  test('should collect first and last names before the goal on the About you step on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.fill('[data-test="email"]', `mobile-profile-e2e-${Date.now()}@example.com`)
    await page.fill('[data-test="password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)

    await expect(page.locator('[data-test="onboarding-welcome-continue"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-first-name"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-last-name"]')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible()
    const nameBox = await page.locator('[data-test="onboarding-first-name"]').boundingBox()
    const surnameBox = await page.locator('[data-test="onboarding-last-name"]').boundingBox()
    expect(nameBox).not.toBeNull()
    expect(surnameBox).not.toBeNull()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await page.fill('[data-test="onboarding-first-name"]', 'Example')
    await page.fill('[data-test="onboarding-last-name"]', 'User')
    await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
    await expect(page.locator('[data-test="onboarding-intent-ota"]')).toHaveCount(0)
    await page.click('[data-test="onboarding-name-continue"]')
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
  })

  for (const mobile of [false, true]) {
    test(`should restore name drafts after refresh before selecting a goal on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
      if (mobile)
        await page.setViewportSize({ width: 390, height: 844 })
      const email = `draft-profile-e2e-${Date.now()}-${mobile}@example.com`
      const password = 'Password123!'
      await page.fill('[data-test="email"]', email)
      await page.fill('[data-test="password"]', password)
      await page.click('[data-test="submit"]')
      await page.waitForURL(/\/onboarding\/name/)
      await continuePastProfileWelcome(page)

      const draftSaved = page.waitForResponse((response) => {
        const query = response.ok() ? consoleQueryFromResponse(response) : null
        if (!query || query.name !== 'users' || consoleQueryMethod(query) !== 'PATCH')
          return false
        const draft = consoleQueryPayload(query)?.onboarding?.profile_draft
        return draft?.first_name === 'Draft' && draft?.last_name === 'User' && draft?.company_name === 'Example Company'
      })
      await page.fill('[data-test="onboarding-first-name"]', 'Draft')
      await page.fill('[data-test="onboarding-last-name"]', 'User')
      await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
      await draftSaved

      const capgo = createClient(localSupabaseUrl, localSupabaseAnonKey)
      const { data: session, error: signInError } = await capgo.auth.signInWithPassword({ email, password })
      expect(signInError).toBeNull()
      const { data: profile, error } = await capgo.from('users')
        .select('first_name, last_name, onboarding')
        .eq('id', session.user!.id)
        .single()
      expect(error).toBeNull()
      expect(profile?.first_name || '').toBe('')
      expect(profile?.last_name || '').toBe('')
      expect(profile?.onboarding).toMatchObject({ profile_draft: { first_name: 'Draft', last_name: 'User', company_name: 'Example Company' } })
      await capgo.auth.signOut({ scope: 'local' })

      await page.reload()
      const firstName = page.locator('[data-test="onboarding-first-name"]')
      await expect(page.locator('[data-test="onboarding-resume-continue"]')).toBeVisible()
      await expect(firstName).toHaveCount(0)
      await page.click('[data-test="onboarding-resume-continue"]')
      await expect(page.locator('[data-test="onboarding-welcome-continue"]')).toHaveCount(0)
      await expect(firstName).toHaveValue('Draft')
      await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('User')
      await expect(page.locator('[data-test="onboarding-company-name"]')).toHaveValue('Example Company')
      await expect(page.locator('[data-test="onboarding-name-continue"]')).toBeEnabled()

      await page.reload()
      await expect(page.locator('[data-test="onboarding-resume-restart"]')).toBeVisible()
      await page.click('[data-test="onboarding-resume-restart"]')
      // Restart lands directly on an empty About you form; there is no welcome screen anymore.
      await expect(page.locator('[data-test="onboarding-welcome-continue"]')).toHaveCount(0)
      await expect(page.locator('[data-test="onboarding-name-step"]')).toBeVisible()
      await expect(firstName).toHaveValue('')
      await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('')
      await expect(page.locator('[data-test="onboarding-company-name"]')).toHaveValue('')
      await expect(page.locator('[data-test="onboarding-name-continue"]')).toBeDisabled()
      await firstName.fill('Draft')
      await page.fill('[data-test="onboarding-last-name"]', 'User')
      await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
      await page.click('[data-test="onboarding-name-continue"]')
      if (!mobile)
        await expectOnboardingGoal(page)
      await page.click('[data-test="onboarding-intent-ota"]')
      await page.click('[data-test="app-onboarding-continue-intent"]')
      await continuePastDevelopmentEnvironmentIfShown(page)
      await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()
    })
  }

  test('should save an incomplete profile before creating a standalone organization', async ({ page }) => {
    const email = `standalone-profile-e2e-${Date.now()}@example.com`
    const password = 'Password123!'
    const capgo = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedUp, error: signUpError } = await capgo.auth.signUp({ email, password })
    expect(signUpError).toBeNull()
    const { error: updateError } = await localAdminClient().from('users').upsert({ id: signedUp.user!.id, email, first_name: 'Example', last_name: '', onboarding: {} }, { onConflict: 'id' })
    expect(updateError).toBeNull()
    await capgo.auth.signOut({ scope: 'local' })

    await loginToOnboarding(page, email, password)
    await page.goto('/onboarding/organization?source=org-switcher')
    await continuePastProfileWelcome(page)
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveValue('Example')
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('')
    await expect(page).toHaveURL(/\/onboarding\/name/)
    const createOrganization = page.locator('[data-test="onboarding-name-continue"]')
    await expect(createOrganization).toBeDisabled()
    await page.fill('[data-test="onboarding-last-name"]', '   ')
    await expect(createOrganization).toBeDisabled()
    await page.fill('[data-test="onboarding-last-name"]', '  User  ')
    await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
    await expect(createOrganization).toBeEnabled()

    const writes: string[] = []
    page.on('request', (request) => {
      const query = parseConsoleQuery(request)
      if (query?.name === 'users' && consoleQueryMethod(query) === 'PATCH' && consoleQueryPayload(query)?.last_name === 'User')
        writes.push('profile')
      if (request.method() === 'POST' && /\/organization(?:\?|$)/.test(request.url()))
        writes.push('organization')
    })
    await createOrganization.click()
    await page.click('[data-test="onboarding-intent-ota"]')
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveCount(0)
    await page.locator('[data-test="onboarding-estimated-users-option"]').first().click()
    await page.click('[data-test="onboarding-create-org"]')
    await expect(page.locator('[data-test="onboarding-logo-action"]')).toBeVisible({ timeout: 60000 })
    expect(writes).toEqual(['profile', 'organization'])

    const { error: signInError } = await capgo.auth.signInWithPassword({ email, password })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await capgo.from('users')
      .select('first_name, last_name')
      .eq('id', signedUp.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'User' })
    await capgo.auth.signOut({ scope: 'local' })
  })

  test('should complete a partial profile and skip both names for subsequent organizations', async ({ page }) => {
    const email = `partial-profile-e2e-${Date.now()}@example.com`
    const password = 'Password123!'
    const capgo = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedUp, error: signUpError } = await capgo.auth.signUp({ email, password })
    expect(signUpError).toBeNull()
    const { data: seededProfile, error: updateError } = await localAdminClient().from('users').upsert({ id: signedUp.user!.id, email, first_name: 'Example', last_name: '', onboarding: {} }, { onConflict: 'id' }).select('first_name, last_name').single()
    expect(updateError).toBeNull()
    expect(seededProfile).toEqual({ first_name: 'Example', last_name: '' })
    await capgo.auth.signOut({ scope: 'local' })

    await loginToOnboarding(page, email, password)
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveValue('Example')
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('')
    await expect(page.locator('[data-test="onboarding-name-continue"]')).toBeDisabled()
    await page.fill('[data-test="onboarding-last-name"]', '  User  ')
    await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
    await expect(page.locator('[data-test="onboarding-name-continue"]')).toBeEnabled()
    await page.click('[data-test="onboarding-name-continue"]')
    await expectOnboardingGoal(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)

    await page.goto('/onboarding/organization?source=org-switcher')
    await page.click('[data-test="onboarding-intent-ota"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-org-name"]')).toHaveCount(0)
    await page.locator('[data-test="onboarding-estimated-users-option"]').first().click()
    const createOrganization = page.locator('[data-test="onboarding-create-org"]')
    await expect(createOrganization).toBeEnabled()
    await createOrganization.click()
    await expect(page.locator('[data-test="onboarding-logo-action"]')).toBeVisible({ timeout: 60000 })

    const { error: signInError } = await capgo.auth.signInWithPassword({ email, password })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await capgo.from('users')
      .select('first_name, last_name')
      .eq('id', signedUp.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'User' })
    await capgo.auth.signOut({ scope: 'local' })

    await page.goto('/onboarding/organization?source=org-switcher')
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="onboarding-mode-name"]')
    await expect(page.locator('[data-test="onboarding-first-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveCount(0)
  })

  test('should preserve an existing surname when saving the first name', async ({ page }) => {
    const email = `surname-profile-e2e-${Date.now()}@example.com`
    const password = 'Password123!'
    const capgo = createClient(localSupabaseUrl, localSupabaseAnonKey)
    const { data: signedUp, error: signUpError } = await capgo.auth.signUp({ email, password })
    expect(signUpError).toBeNull()
    const { error: updateError } = await localAdminClient().from('users').upsert({ id: signedUp.user!.id, email, first_name: '', last_name: 'Existing', onboarding: {} }, { onConflict: 'id' })
    expect(updateError).toBeNull()
    await capgo.auth.signOut({ scope: 'local' })

    await loginToOnboarding(page, email, password)
    await expect(page.locator('[data-test="onboarding-last-name"]')).toHaveValue('Existing')
    await page.fill('[data-test="onboarding-first-name"]', '  Example  ')
    await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
    await page.click('[data-test="onboarding-name-continue"]')
    await expectOnboardingGoal(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)
    await expect(page.locator('[data-test="app-onboarding-name"]')).toBeVisible()

    const { error: signInError } = await capgo.auth.signInWithPassword({ email, password })
    expect(signInError).toBeNull()
    const { data: profile, error: profileError } = await capgo.from('users')
      .select('first_name, last_name')
      .eq('id', signedUp.user!.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({ first_name: 'Example', last_name: 'Existing' })
    await capgo.auth.signOut({ scope: 'local' })
  })

  test('should offer to continue or restart onboarding after a dropout', async ({ page }) => {
    const uniqueSuffix = Date.now()
    const email = `onboarding-resume-e2e-${uniqueSuffix}@example.com`
    const appName = `Resume App ${uniqueSuffix}`
    const password = 'Password123!'

    await page.fill('[data-test="email"]', email)
    await page.fill('[data-test="password"]', password)
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)
    await completeName(page)
    await expectOnboardingGoal(page)
    await page.click('[data-test="onboarding-intent-ota"]')
    await page.click('[data-test="app-onboarding-continue-intent"]')
    await continuePastDevelopmentEnvironmentIfShown(page)
    await page.fill('[data-test="app-onboarding-name"]', appName)
    await continueFromAppNameToIcon(page)
    await Promise.all([
      page.waitForResponse((response) => {
        // The onboarding step is saved through the console query endpoint (users update).
        const query = response.ok() ? consoleQueryFromResponse(response) : null
        return !!query && query.name === 'users' && consoleQueryMethod(query) === 'PATCH' && JSON.stringify(consoleQueryPayload(query) ?? {}).includes('"step":"organization"')
      }),
      page.click('[data-test="app-onboarding-continue"]'),
    ])
    await expect(page.locator('[data-test="onboarding-company-name-summary"]')).toHaveText('Example Company')

    await page.click('[data-test="onboarding-logout"]')
    await page.waitForURL(/\/login\/?$/)
    await loginToOnboarding(page, email, password)

    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toBeVisible()
    await page.locator('[data-test="onboarding-resume-continue"]').click()
    await expect(page.locator('[data-test="onboarding-company-name-summary"]')).toHaveText('Example Company')

    await page.click('[data-test="onboarding-logout"]')
    await page.waitForURL(/\/login\/?$/)
    await loginToOnboarding(page, email, password)
    await expect(page.locator('[data-test="onboarding-resume-restart"]')).toBeVisible()
    await page.locator('[data-test="onboarding-resume-restart"]').click()
    await continuePastProfileWelcome(page)
    await page.fill('[data-test="onboarding-company-name"]', 'Example Company')
    await page.locator('[data-test="onboarding-name-continue"]').click()
    await expectOnboardingGoal(page)
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
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)
    await completeName(page)
    await expectOnboardingGoal(page)
    await forceWebNativeOnboardingTreatments(email, password)
    await page.reload()
    await expect(page.locator('[data-test="onboarding-resume-continue"]')).toBeVisible()
    await page.locator('[data-test="onboarding-resume-continue"]').click()

    await expect(page.locator('[data-test="onboarding-intent-publish"]')).toBeVisible()
    await expect(page.locator('[data-test="onboarding-development-environment-hosted_builder"]')).toHaveCount(0)
    await page.click('[data-test="onboarding-intent-publish"]')
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
    await page.click('[data-test="submit"]')

    await page.waitForURL(/\/onboarding\/name/)
    await continuePastProfileWelcome(page)
    await completeName(page)
    await page.click('[data-test="onboarding-logout"]')

    await page.waitForURL(/\/login\/?$/)
    await expectProtectedRouteRedirect(page, '/apps', /\/login/, '[data-test="email"]')
  })

  test('should show error for existing email', async ({ page }) => {
    await page.fill('[data-test="email"]', 'test@capgo.app')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('User already registered')
  })

  test('should show error for deleted account email', async ({ page }) => {
    await page.fill('[data-test="email"]', 'deleted@capgo.app')
    await page.fill('[data-test="password"]', 'Password123!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-test="form-error"]')).toContainText('Account with this email used to exist, cannot recreate')
  })

  test('should require a number before submitting to the registration API', async ({ page }) => {
    let requests = 0
    page.on('request', (request) => {
      if (request.url().endsWith('/auth/register') && request.method() === 'POST')
        requests++
    })
    await page.fill('[data-test="email"]', 'password-policy@example.com')
    await page.fill('[data-test="password"]', 'Password!')
    await page.click('[data-test="submit"]')
    await expect(page.locator('[data-message-type="validation"]')).toContainText(/number/i)
    expect(requests).toBe(0)
    await expect(page).toHaveURL(/\/register\/?$/)
  })
})
