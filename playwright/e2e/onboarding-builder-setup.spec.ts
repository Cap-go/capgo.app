import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html?view=builder'

test('shows live Builder progress while keeping platform tasks separate', async ({ page }) => {
  await page.clock.install()
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
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveText('0 of 6 complete')
  await expect(page.locator('[data-test="builder-step-start_setup"]')).toContainText('Current task')
  await expect(page.locator('[data-test="builder-checklist-command"]')).toHaveText('npx @capgo/cli@latest build init -a [API_KEY] --platform ios')
  await page.locator('[data-test="builder-step-prepare_certificate"] button').click()
  await expect(page.locator('[data-test="builder-checklist-instructions"]')).toContainText('Import an existing Apple distribution certificate')
  await expect(page.locator('[data-test="builder-checklist-instructions"]')).toContainText('Not started')

  await page.evaluate(() => {
    (window as any).onboardingSetupPreview.state.builderSteps.ios.start_setup = { status: 'done' }
  })
  await page.clock.runFor(5000)
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveText('1 of 6 complete')
  await expect(page.locator('[data-test="builder-step-start_setup"]')).toHaveAttribute('data-status', 'done')
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
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveText('0 of 4 complete')
  await page.locator('[data-test="builder-checklist-command"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('copy-builder-android')

  await page.locator('[data-test="builder-platform-ios"]').click()
  await expect(page.locator('[data-test="builder-step-start_setup"]')).toHaveAttribute('data-status', 'done')
  await expect(page.locator('[data-test="builder-step-choose_destination"]')).toContainText('Current task')
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
})

test('requires a successful cloud build before showing completion', async ({ page }) => {
  await page.clock.install()
  await page.goto(`${fixture}&platform=android`)
  await expect(page.locator('[data-test="builder-platform-android"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveText('0 of 4 complete')

  await page.evaluate(() => {
    (window as any).onboardingSetupPreview.state.builderSteps.android = {
      start_setup: { status: 'done' },
      prepare_keystore: { status: 'done' },
      connect_google_play: { status: 'skipped' },
      successful_cloud_build: { status: 'pending' },
    }
  })
  await page.clock.runFor(5000)
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveText('3 of 4 complete')
  await expect(page.getByRole('heading', { name: 'Your first cloud build succeeded' })).toHaveCount(0)

  await page.evaluate(() => {
    (window as any).onboardingSetupPreview.state.builderSteps.android.successful_cloud_build = { status: 'done' }
  })
  await page.clock.runFor(5000)
  await expect(page.locator('[data-test="builder-checklist-progress"]')).toHaveText('4 of 4 complete')
  await expect(page.getByRole('heading', { name: 'Your first cloud build succeeded' })).toBeVisible()
  await page.getByRole('button', { name: 'Open your app' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('complete')
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
