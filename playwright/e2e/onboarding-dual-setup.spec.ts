import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html?view=flow&assignment=both-builder&resume=com.example.onboarding-preview&step=setup'

test('chooses a goal, switches plain tabs, preserves instructions and places dismissal at the bottom', async ({ page }) => {
  await page.goto(fixture)
  await expect(page.getByRole('heading', { name: 'What would you like to start with?' })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  const dismiss = page.getByRole('button', { name: 'Don\'t show this again', exact: true })
  expect((await dismiss.boundingBox())!.y).toBeGreaterThan(500)
  await page.getByRole('button', { name: /Live Updates/ }).click()
  await expect(page.getByRole('tab')).toHaveText(['Live Updates', 'Builder'])
  await expect(page.locator('[data-test="app-onboarding-command-copy"]')).toContainText('@capgo/cli@latest i ')
  await page.locator('[data-test="app-onboarding-cli-step-add_updater"] button').click()
  await page.getByRole('tab', { name: 'Builder', exact: true }).click()
  await page.locator('[data-test="builder-platform-android"]').click()
  await expect(page.locator('[data-test="builder-checklist-command"]')).toContainText('build init -a ')
  await expect(page.locator('[data-test="builder-checklist-command"]')).toContainText('--platform android')
  await page.locator('[data-test="builder-step-prepare_keystore"] button').click()
  await page.getByRole('tab', { name: 'Live Updates', exact: true }).click()
  await expect(page.locator('[data-test="setup-checklist-instructions"] h2')).toHaveText('Install Capgo Updater')
  await page.getByRole('tab', { name: 'Builder', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-test="builder-checklist-instructions"] h2')).toHaveText('Prepare your signing keystore')
  await page.getByRole('tab', { name: 'Builder', exact: true }).press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Live Updates', exact: true })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Live Updates', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
  await page.reload()
  await expect(page.getByRole('heading', { name: 'What would you like to start with?' })).toBeVisible()
})

for (const { query, path, platform } of [
  { query: '&otaProgress=1', path: 'Live Updates' },
  { query: '&builderProgress=android&platform=ios', path: 'Builder', platform: 'android' },
]) {
  test(`resumes saved ${path} progress without the chooser`, async ({ page }) => {
    await page.goto(`${fixture}${query}`)
    await expect(page.getByRole('tab', { name: path, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-test="setup-goal-chooser"]')).toHaveCount(0)
    if (platform)
      await expect(page.locator(`[data-test="builder-platform-${platform}"]`)).toHaveAttribute('aria-pressed', 'true')
  })
}

test('remembers the last-used unfinished path and platform across reopening', async ({ page }) => {
  await page.goto(`${fixture}&otaProgress=1&builderProgress=android`)
  await page.getByRole('tab', { name: 'Builder', exact: true }).click()
  await expect(page.locator('[data-test="builder-platform-android"]')).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-test="builder-platform-android"]')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', { name: 'Live Updates', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Live Updates', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('keeps the chooser and tabs usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(fixture)
  await page.getByRole('button', { name: /Live Updates/ }).click()
  await expect(page.getByRole('tab')).toHaveText(['Live Updates', 'Builder'])
  await page.getByRole('tab', { name: 'Builder', exact: true }).click()
  await page.locator('[data-test="builder-platform-ios"]').click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})

test('prefers unfinished Builder when OTA is complete and retains both completion panels', async ({ page }) => {
  await page.goto(`${fixture}&otaComplete=1`)
  await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Live Updates', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue Builder', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue Builder', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])

  await page.goto(`${fixture}&otaComplete=1&builderComplete=android`)
  await expect(page.getByRole('heading', { name: 'Your first cloud build succeeded' })).toBeVisible()
  await expect(page.locator('[data-test="setup-goal-chooser"]')).toHaveCount(0)
})

test('returns from Explore dashboard to saved progress in the existing setup route', async ({ page }) => {
  await page.goto(`${fixture.replace('view=flow', 'view=navigation')}&otaProgress=1&builderProgress=android`)
  await page.getByRole('tab', { name: 'Builder', exact: true }).click()
  await page.locator('[data-test="setup-checklist-explore-dashboard"]').click()
  await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
  await page.locator('[data-test="getting-started-nav-link"]').click()
  await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-test="builder-platform-android"]')).toHaveAttribute('aria-pressed', 'true')
})

test('preserves inspected tasks across Builder platforms and continues the unfinished platform', async ({ page }) => {
  await page.clock.install()
  await page.goto(`${fixture}&otaComplete=1&builderProgress=ios&builderComplete=android`)
  await page.locator('[data-test="builder-step-start_setup"] button').click()
  await page.locator('[data-test="builder-platform-android"]').click()
  await expect(page.getByRole('button', { name: 'Continue Builder', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue Builder', exact: true }).click()
  await expect(page.locator('[data-test="builder-platform-ios"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-test="builder-checklist-instructions"] h2')).toHaveText('Start guided Builder setup')

  await page.goto(`${fixture}&builderProgress=ios`)
  await page.evaluate(() => {
    const steps = (window as any).onboardingSetupPreview.state.builderSteps.ios
    steps.choose_destination.status = 'done'
    steps.connect_app_store.status = 'done'
  })
  await page.clock.runFor(5000)
  await expect(page.locator('[data-test="builder-step-prepare_certificate"]')).toContainText('Current task')
  await page.locator('[data-test="builder-step-start_setup"] button').click()
  await page.locator('[data-test="builder-platform-android"]').click()
  await page.locator('[data-test="builder-platform-ios"]').click()
  await expect(page.locator('[data-test="builder-checklist-instructions"] h2')).toHaveText('Start guided Builder setup')
})

test('copies commands and OTA AI instructions for the active tab rather than signup intent', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (text: string) => {
        (window as any).copiedSetupText = text
      },
    } })
  })
  await page.goto(fixture)
  await page.getByRole('button', { name: /Builder Build/ }).click()
  await page.locator('[data-test="builder-platform-android"]').click()
  await page.locator('[data-test="builder-checklist-command"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).copiedSetupText)).toMatch(/@capgo\/cli@latest build init -a .* --platform android$/)
  await page.getByRole('tab', { name: 'Live Updates', exact: true }).click()
  await page.locator('[data-test="app-onboarding-command-copy"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).copiedSetupText)).toContain('@capgo/cli@latest i ')
  await page.locator('[data-test="setup-checklist-copy-ai"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).copiedSetupText)).toContain('OTA todo list progress checks')
  const prompt = await page.evaluate(() => (window as any).copiedSetupText as string)
  expect(prompt).not.toContain('start_capgo_builder_onboarding')
})
