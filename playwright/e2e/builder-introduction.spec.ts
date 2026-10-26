import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html?view=builder-intro&otaProgress=1&checklistState=dismissed&page=1&sort_created_at=desc'

function canonicalUrl(value: string | URL) {
  const url = new URL(value)
  url.searchParams.sort()
  return url.href
}

test.use({ reducedMotion: 'reduce' })

for (const channelTreatment of [false, true]) {
  test(`starts Builder inline on the final click and retains OTA progress (channel treatment ${channelTreatment})`, async ({ page }) => {
    const url = `${fixture}&legacyChannel=1&channelTreatment=${Number(channelTreatment)}`
    await page.goto(url)
    await expect(page.locator('[data-test="builder-introduction"]')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
    for (let slide = 0; slide < 4; slide++) {
      await page.locator('.bp-next').click()
      await expect(page.locator('.bp-dot').nth(slide + 1)).toHaveClass('bp-dot on')
      await expect(page.locator('.bp-slide.show')).toHaveCount(1)
    }
    const cta = page.getByRole('button', { name: 'Start my first build', exact: true })
    await expect(cta).toBeVisible()
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.builderActivationRequests)).toEqual([])
    await page.evaluate(() => (window as any).onboardingSetupPreview.state.builderActivationDelayMs = 300)
    await expect(page).toHaveURL(url => url.searchParams.get('page') === '1' && url.searchParams.get('sort_created_at') === 'desc')
    const inlineUrl = canonicalUrl(page.url())
    await cta.click()
    await expect(cta).toBeDisabled()
    await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(url => canonicalUrl(url) === inlineUrl)
    await expect(page.getByRole('button', { name: "Don't show this again", exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Explore dashboard', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).onboardingSetupPreview.state.builderActivationRequests)).toEqual([{ method: 'POST', appId: 'com.example.onboarding-preview' }])
    await page.getByRole('tab', { name: 'Live Updates', exact: true }).click()
    await expect(page.locator('[data-test="app-onboarding-cli-step-login_cli_mcp"]')).toHaveAttribute('data-status', 'done')
  })
}

test('keeps the presentation open and allows retry when activation fails', async ({ page }) => {
  await page.goto(fixture)
  await page.evaluate(() => (window as any).onboardingSetupPreview.state.builderActivationError = true)
  for (let slide = 0; slide < 4; slide++) {
    await page.locator('.bp-next').click()
    await expect(page.locator('.bp-dot').nth(slide + 1)).toHaveClass('bp-dot on')
    await expect(page.locator('.bp-slide.show')).toHaveCount(1)
  }
  const cta = page.getByRole('button', { name: 'Start my first build', exact: true })
  await cta.click()
  await expect(page.getByRole('alert')).toContainText('Could not start Builder setup')
  await expect(cta).toBeEnabled()
  await expect(page).toHaveURL(/view=builder-intro/)
  await page.evaluate(() => (window as any).onboardingSetupPreview.state.builderActivationError = false)
  await cta.click()
  await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('offers a secondary first-build action to the left of Next and opens the checklist inline', async ({ page }) => {
  await page.goto(fixture)
  const start = page.getByRole('button', { name: 'Get started with my first build', exact: true })
  const next = page.getByRole('button', { name: 'Next →', exact: true })
  await expect(start).toBeVisible()
  await expect(page.getByRole('heading', { name: "There's more in your plan than you're using.", exact: true })).toBeVisible()
  await expect(page).toHaveURL(url => url.searchParams.get('page') === '1' && url.searchParams.get('sort_created_at') === 'desc')
  const inlineUrl = canonicalUrl(page.url())
  const startBox = await start.boundingBox()
  const nextBox = await next.boundingBox()
  expect(startBox!.x + startBox!.width).toBeLessThanOrEqual(nextBox!.x)
  await start.click()
  await expect(page.getByRole('tab', { name: 'Builder', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(url => canonicalUrl(url) === inlineUrl)
  await expect(page.getByRole('button', { name: "Don't show this again", exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).not.toContain('getting-started-mounted')
})

for (const assignment of ['builder-only', 'both-builder']) {
  test(`hides onboarding exit controls for the existing inline ${assignment} checklist`, async ({ page }) => {
    const url = `${fixture}&assignment=${assignment}&platform=android`
    await page.goto(url)
    await expect(page.locator('[data-test="builder-checklist"]')).toBeVisible()
    await expect(page.getByRole('button', { name: "Don't show this again", exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Explore dashboard', exact: true })).toHaveCount(0)
    await expect(page.getByText('Hide setup and return to your dashboard. You can reopen setup later.', { exact: true })).toHaveCount(0)
    await expect(page).not.toHaveURL(/\/getting-started/)
  })
}

test('keeps intro footer controls inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto(fixture)
  for (const button of [page.getByRole('button', { name: 'Get started with my first build', exact: true }), page.locator('.bp-next')]) {
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
  }
})
