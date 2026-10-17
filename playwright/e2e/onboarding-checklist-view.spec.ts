import { expect, test } from '@playwright/test'

const appId = 'com.example.onboarding-preview'
const gettingStarted = `/app/${appId}/getting-started`

test.beforeEach(async ({ page }) => {
  const response = await page.request.get('/playwright/fixtures/onboarding-setup.html')
  const html = (await response.text()).replace('src="./onboarding-setup.ts', 'src="/playwright/fixtures/onboarding-setup.ts')
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'document')
      await route.fulfill({ body: html, contentType: 'text/html' })
    else
      await route.continue()
  })
})

for (const preOrg of [false, true]) {
  for (const scenario of [
    { name: 'legacy OTA', query: 'version=2', completed: 'Guided setup complete' },
    { name: 'v3 OTA', query: 'version=3', completed: 'Guided setup complete' },
    { name: 'v4 OTA', query: 'assignment=both-ota', completed: 'Guided setup complete' },
    { name: 'iOS Builder', query: 'assignment=builder-only&platform=ios', completed: 'Your first cloud build succeeded' },
    { name: 'Android Builder', query: 'assignment=both-builder&platform=android', completed: 'Your first cloud build succeeded' },
  ]) {
    test(`views completed ${scenario.name} with showChecklist=1 (${preOrg ? 'pre-org handoff' : 'existing org'})`, async ({ page }) => {
      const url = `${gettingStarted}?${scenario.query}&checklistState=completed&preOrg=${Number(preOrg)}&showChecklist=1&legacyChannel=1&channelTreatment=1&wrongOrg=1`
      await page.goto(url)
      if (scenario.name === 'legacy OTA')
        await expect(page.getByRole('button', { name: 'Setup checklist 7 of 7 steps', exact: true })).toBeVisible()
      else
        await expect(page.getByRole('heading', { name: scenario.completed, exact: true })).toBeVisible()
      await expect(page).toHaveURL(url)
      await expect(page.locator('[data-test="preview-app-dashboard"]')).toHaveCount(0)
      const builder = scenario.name.includes('Builder')
      await expect(page.locator(builder ? '[data-test="builder-step-start_setup"]' : '[data-test="app-onboarding-cli-step-login_cli_mcp"]')).toHaveAttribute('data-status', 'done')
      if (scenario.name !== 'iOS Builder')
        await expect(page.locator(builder ? '[data-test="builder-step-connect_google_play"]' : '[data-test="app-onboarding-cli-step-add_code"]')).toHaveAttribute('data-status', 'skipped')
      const state = await page.evaluate(() => {
        const preview = (window as any).onboardingSetupPreview
        return { appWrites: preview.state.appWrites, userWrites: preview.state.userWrites, orgId: preview.selectedOrgId.value }
      })
      expect(state).toEqual({ appWrites: [], userWrites: [], orgId: '00000000-0000-4000-8000-000000000002' })
      // Leaving the view must not restart the user's completed onboarding either.
      await page.getByRole('button', { name: scenario.name === 'legacy OTA' ? 'Explore Capgo dashboard' : 'Open your app', exact: true }).click()
      await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
      expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.userWrites)).toEqual([])
      expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
    })
  }
}

for (const assignment of ['ota-only', 'builder-only']) {
  test(`retains normal ${assignment} feature and outcome writes without the opt-in`, async ({ page }) => {
    await page.goto(`${gettingStarted}?assignment=${assignment}&platform=android&checklistState=pending`)
    await expect.poll(() => page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites.some((write: any) => write.body?.p_feature_key))).toBe(true)
    await page.getByRole('button', { name: 'Explore dashboard', exact: true }).click()
    await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites.some((write: any) => write.body?.onboarding?.outcome === 'switched_to_manual'))).toBe(true)
  })

  test(`shows persisted done, skipped and pending ${assignment} tasks after dismissal`, async ({ page }) => {
    await page.goto(`${gettingStarted}?assignment=${assignment}&platform=android&checklistState=dismissed&showChecklist=1`)
    const builder = assignment === 'builder-only'
    const step = (id: string) => page.locator(`[data-test="${builder ? 'builder-step' : 'app-onboarding-cli-step'}-${id}"]`)
    await expect(step(builder ? 'start_setup' : 'login_cli_mcp')).toHaveAttribute('data-status', 'done')
    await expect(step(builder ? 'connect_google_play' : 'add_updater')).toHaveAttribute('data-status', 'skipped')
    await expect(step(builder ? 'successful_cloud_build' : 'test_update')).toHaveAttribute('data-status', 'pending')
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
    await page.getByRole('button', { name: 'Explore dashboard', exact: true }).click()
    await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
  })

  for (const parameter of ['', '&showChecklist=0', '&showChecklist=false', '&showChecklist', '&showChecklist=1&showChecklist=0']) {
    test(`preserves completed ${assignment} redirect for ${parameter || 'no parameter'}`, async ({ page }) => {
      await page.goto(`${gettingStarted}?assignment=${assignment}&platform=android&checklistState=completed${parameter}`)
      await expect(page).toHaveURL(`/app/${appId}`)
      await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
    })
  }

  test(`preserves dismissed ${assignment} redirect on the pre-org path without the opt-in`, async ({ page }) => {
    await page.goto(`${gettingStarted}?assignment=${assignment}&platform=android&checklistState=dismissed&preOrg=1`)
    await expect(page).toHaveURL(`/app/${appId}`)
    await expect(page.locator('[data-test="preview-app-dashboard"]')).toBeVisible()
  })
}

test('keeps unavailable apps behind the existing not-found page', async ({ page }) => {
  await page.goto(`${gettingStarted}?showChecklist=1&unavailable=1`)
  await expect(page.getByRole('heading', { name: 'App not found', exact: true })).toBeVisible()
  await expect(page.locator('[data-test="getting-started-setup"]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.appWrites)).toEqual([])
})
