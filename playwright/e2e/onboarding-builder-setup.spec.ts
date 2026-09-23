import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html?view=builder'

test('shows every configured Builder task and keeps platform navigation local and separate', async ({ page }) => {
  await page.goto(fixture)
  await expect(page.getByRole('heading', { name: 'Build your first native app' })).toBeVisible()
  await expect(page.locator('[data-test="builder-checklist-choose-platform"]')).toBeVisible()

  await page.locator('[data-test="builder-platform-ios"]').click()
  await expect(page.locator('[data-test^="builder-step-"] button')).toContainText([
    'Start guided Builder setup',
    'Choose where the build goes',
    'Connect App Store Connect',
    'Prepare a distribution certificate',
    'Prepare a provisioning profile',
    'Run a successful cloud build',
  ])
  await expect(page.locator('[data-test^="builder-step-"]')).toHaveCount(6)
  await expect(page.locator('[data-test="builder-checklist-command"]')).toHaveText('npx @capgo/cli@latest build init -a [API_KEY] --platform ios')
  await page.locator('[data-test="builder-step-prepare_certificate"] button').click()
  await expect(page.locator('[data-test="builder-checklist-instructions"]')).toContainText('Import an existing Apple distribution certificate')

  await page.locator('[data-test="builder-platform-android"]').click()
  await expect(page.locator('[data-test^="builder-step-"] button')).toContainText([
    'Start guided Builder setup',
    'Prepare your signing keystore',
    'Connect Google Play',
    'Run a successful cloud build',
  ])
  await expect(page.locator('[data-test^="builder-step-"]')).toHaveCount(4)
  await expect(page.locator('[data-test="builder-step-choose_destination"]')).toHaveCount(0)
  await expect(page.locator('[data-test="builder-step-prepare_certificate"]')).toHaveCount(0)
  await expect(page.locator('[data-test="builder-checklist-command"]')).toHaveText('npx @capgo/cli@latest build init -a [API_KEY] --platform android')
  await page.locator('[data-test="builder-step-connect_google_play"] button').click()
  await expect(page.locator('[data-test="builder-checklist-instructions"]')).toContainText('Google Play upload needs a service account')

  await page.locator('[data-test="builder-platform-ios"]').click()
  await expect(page.locator('[data-test="builder-checklist-instructions"]')).toContainText('Import an existing Apple distribution certificate')
  await page.locator('[data-test="builder-platform-android"]').click()
  await expect(page.locator('[data-test="builder-checklist-instructions"]')).toContainText('Google Play upload needs a service account')

  await expect(page.locator('[data-test^="builder-step-"][data-status]')).toHaveCount(0)
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
})

test('uses the stored Builder platform when one exists without writing progress', async ({ page }) => {
  await page.goto(`${fixture}&platform=android`)
  await expect(page.locator('[data-test="builder-platform-android"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-test^="builder-step-"]')).toHaveCount(4)
  await page.locator('[data-test="builder-checklist-command"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('copy-builder-android')
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
})

for (const { assignment, checklist } of [
  { assignment: 'builder-only', checklist: 'builder' },
  { assignment: 'ota-only', checklist: 'ota' },
  { assignment: 'both-builder', checklist: 'builder' },
  { assignment: 'both-ota', checklist: 'ota' },
] as const) {
  test(`routes ${assignment} onboarding to the ${checklist} checklist`, async ({ page }) => {
    await page.goto(`/playwright/fixtures/onboarding-setup.html?view=flow&assignment=${assignment}&platform=ios&resume=com.example.onboarding-preview&step=setup`)
    if (checklist === 'builder') {
      await expect(page.locator('[data-test="builder-checklist"]')).toBeVisible()
      await expect(page.locator('[data-test="onboarding-setup-cli"]')).toHaveCount(0)
    }
    else {
      await expect(page.locator('[data-test="onboarding-setup-cli"]')).toBeVisible()
      await expect(page.locator('[data-test="builder-checklist"]')).toHaveCount(0)
    }
  })
}
