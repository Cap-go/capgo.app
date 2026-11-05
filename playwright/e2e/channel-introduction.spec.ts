import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/onboarding-setup.html?view=channel-introduction'

test('explains channels inline, keeps documentation beside Continue, and creates only on request', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(fixture)
  const intro = page.locator('[data-test="channel-introduction"]')
  await expect(intro).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
  await page.screenshot({ path: '.context/onboarding-design/channel-introduction.png', fullPage: true })

  for (const stage of ['default-routing', 'self-assign', 'console-assign']) {
    const next = intro.locator(`[data-test="channel-${stage}-continue"]`)
    const footer = intro.locator('footer')
    await expect(footer.getByRole('link', { name: /Learn more/ })).toHaveAttribute('href', 'https://capgo.app/docs/live-updates/channels/')
    await expect(next).toBeEnabled()
    const before = await page.evaluate(() => ({
      events: (window as any).onboardingSetupPreview.events,
      inserts: (window as any).onboardingSetupPreview.state.channelInserts,
      setupWrites: (window as any).onboardingSetupPreview.state.setupWrites,
      onboardingEvents: (window as any).onboardingSetupPreview.channelEvents,
    }))
    expect(before.events).not.toContain('channel-create-requested')
    expect(before.inserts).toEqual([])
    expect(before.setupWrites).toEqual([])
    expect(before.onboardingEvents).toEqual([])
    await next.click()
  }
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).toContain('channel-create-requested')
})

test('allows skipping the explanation and hides the quick create action for readers', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(fixture)
  await page.locator('[data-test="channel-intro-create"]').click()
  expect(await page.evaluate(() => (window as any).onboardingSetupPreview.events)).toEqual(['channel-create-requested'])
  await page.goto(`${fixture}&readOnly=1`)
  await expect(page.locator('[data-test="channel-introduction"]')).toBeVisible()
  await expect(page.locator('[data-test="channel-intro-create"]')).toHaveCount(0)
  await page.locator('[data-test="channel-default-routing-continue"]').click()
  await page.locator('[data-test="channel-self-assign-continue"]').click()
  await page.getByRole('button', { name: 'Replay introduction', exact: true }).click()
  await expect(page.locator('[data-test="channel-default-routing-animation"]')).toBeVisible()
})

test('keeps the mobile animations within the page and supports back navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(fixture)
  for (const stage of ['default-routing', 'self-assign', 'console-assign']) {
    await expect(page.locator(`[data-test="channel-${stage}-continue"]`)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const footerFits = await page.locator('[data-test="channel-introduction"] footer').evaluate((footer) => {
      const bounds = footer.getBoundingClientRect()
      return Array.from(footer.querySelectorAll('a, button')).every((action) => {
        const rect = action.getBoundingClientRect()
        return rect.left >= bounds.left && rect.right <= bounds.right
      })
    })
    expect(footerFits).toBe(true)
    if (stage !== 'console-assign')
      await page.locator(`[data-test="channel-${stage}-continue"]`).click()
  }
  await page.locator('[data-test="channel-console-assign-back"]').click()
  await expect(page.locator('[data-test="channel-self-assign-stage"]')).toBeVisible()
  await page.locator('[data-test="channel-self-assign-back"]').click()
  await expect(page.locator('[data-test="channel-default-routing-animation"]')).toBeVisible()
})

test('keeps request, policy and response markers on their dotted paths in a wide centered canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(fixture)
  await page.locator('[data-test="channel-default-routing-continue"]').click()
  await expect(page.locator('[data-test="channel-self-assign-stage"]')).toBeVisible()
  await page.waitForFunction(() => (window as any).onboardingSetupPreview.gsap.globalTimeline.getChildren()
    .some((animation: any) => animation.labels?.['routing-request']))
  const result = await page.evaluate(() => {
    const { gsap } = (window as any).onboardingSetupPreview
    const stage = document.querySelector<HTMLElement>('.csa-stage')!
    const canvas = stage.querySelector<HTMLElement>('.csa-routing-canvas')!
    const timeline = gsap.globalTimeline.getChildren().find((animation: any) => animation.labels?.['routing-request'])
    timeline.pause()
    const distances: number[] = []
    for (const [packetSelector, pathSelector] of [
      ['.csa-request-packet', '.csa-path-request'],
      ['.csa-policy-packet', '.csa-path-beta'],
      ['.csa-response-packet', '.csa-path-beta'],
    ]) {
      const packet = stage.querySelector(packetSelector!)!
      const path = stage.querySelector<SVGPathElement>(pathSelector!)!
      const tween = timeline.getChildren().find((animation: any) => animation.vars.motionPath && animation.targets().includes(packet))
      for (const progress of [0.25, 0.5, 0.75]) {
        timeline.seek(tween.startTime() + tween.duration() * progress, false)
        const rect = packet.getBoundingClientRect()
        const matrix = path.getScreenCTM()!
        let distance = Number.POSITIVE_INFINITY
        for (let i = 0; i <= 1000; i++) {
          const point = path.getPointAtLength(path.getTotalLength() * i / 1000)
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
          distance = Math.min(distance, Math.hypot(rect.left + rect.width / 2 - screen.x, rect.top + rect.height / 2 - screen.y))
        }
        distances.push(distance)
      }
    }
    timeline.seek('routing-request+=0.6', false)
    return { distances, margin: canvas.getBoundingClientRect().left - stage.getBoundingClientRect().left }
  })
  expect(result.margin).toBeGreaterThan(20)
  expect(result.distances).toHaveLength(9)
  for (const distance of result.distances)
    expect(distance).toBeLessThan(1)
  await page.screenshot({ path: '.context/onboarding-design/channel-marker-alignment.png', fullPage: true })
})
