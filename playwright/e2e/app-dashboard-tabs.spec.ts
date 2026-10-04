import { expect, test } from '../support/commands'

const TEST_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'

test.describe('App overview', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
    await page.evaluate((userId) => {
      localStorage.setItem(`capgo.supportUsernames.dismissed.${userId}`, '1')
    }, TEST_USER_ID)
  })

  test('shows a one-screen summary without dashboard subtabs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/app/com.demo.app')

    await expect(page.locator('[data-testid="app-overview"]')).toBeVisible()
    await expect(page.locator('[data-testid="overview-kpis"] a')).toHaveCount(6)
    await expect(page.getByRole('button', { name: 'Installs', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Active Bundle', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Active bundle' })).toBeVisible()

    // The whole summary fits above the fold.
    const issues = page.locator('[data-testid="overview-top-issues"]')
    await expect(issues).toBeVisible()
    const box = await issues.boundingBox()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900)

    await page.locator('[data-testid="overview-kpi-errors"]').click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/errors\?days=7/)
  })

  test('redirects the old overview subtabs to Observe and billing usage to Settings', async ({ page }) => {
    await page.goto('/app/com.demo.app/installs')
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/releases(?:\?|$)/)
    await expect(page.locator('[data-testid="bundle-install-stats"]')).toBeVisible()

    await page.goto('/app/com.demo.app/active-bundle')
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/releases(?:\?|$)/)

    await page.goto('/app/com.demo.app/live?version=1.0.0')
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/releases\?version=1\.0\.0/)
    await expect(page.locator('[data-testid="release-live"]')).toBeVisible()

    await page.goto('/app/com.demo.app/native')
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/native(?:\?|$)/)
    await expect(page.getByRole('heading', { name: 'Native build by platform' })).toBeVisible()

    await page.goto('/app/com.demo.app/settings/usage')
    await expect(page.getByRole('button', { name: 'Usage', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#mau-stat')).toBeVisible()
  })

  test('releases period defaults to 7 days and drives the version chart', async ({ page }) => {
    function daySpan(from: string | null, to: string | null) {
      if (!from || !to)
        return Number.NaN
      const fromDate = new Date(`${from}T00:00:00.000Z`)
      const toDate = new Date(`${to}T00:00:00.000Z`)
      return Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000))
    }

    const periodButton = (name: string) => page.locator('[data-testid="period-day-selector"]').getByRole('button', { name, exact: true })
    const range = page.locator('[data-testid="version-chart-range"]')

    await page.goto('/app/com.demo.app/observe/releases')
    await expect(periodButton('7 days')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => daySpan(await range.getAttribute('data-from'), await range.getAttribute('data-to'))).toBe(6)

    await periodButton('30 days').click()
    await expect(page).toHaveURL(/[?&]days=30(?:&|$)/)
    await expect.poll(async () => daySpan(await range.getAttribute('data-from'), await range.getAttribute('data-to'))).toBe(29)

    await periodButton('1 day').click()
    await expect(page).toHaveURL(/[?&]days=1(?:&|$)/)
    await expect.poll(async () => daySpan(await range.getAttribute('data-from'), await range.getAttribute('data-to'))).toBe(1)
  })
})
