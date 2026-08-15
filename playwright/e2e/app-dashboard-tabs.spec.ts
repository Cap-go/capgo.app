import { expect, test } from '../support/commands'

test.describe('App dashboard sections', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('moves native, installs, and active bundle into dashboard subtabs', async ({ page }) => {
    await page.goto('/app/com.demo.app')

    const usageTab = page.getByRole('button', { name: 'Usage', exact: true })
    const nativeTab = page.getByRole('button', { name: 'Native', exact: true })
    const installsTab = page.getByRole('button', { name: 'Installs', exact: true })
    const activeBundleTab = page.getByRole('button', { name: 'Active Bundle', exact: true })

    await expect(usageTab).toBeVisible()
    await expect(nativeTab).toBeVisible()
    await expect(installsTab).toBeVisible()
    await expect(activeBundleTab).toBeVisible()
    await expect(usageTab).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-testid="bundle-install-stats"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Native build by platform' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Active bundle' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Bundle install performance' })).toHaveCount(0)

    await nativeTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/native(?:\?|$)/)
    await expect(nativeTab).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Native build by platform' })).toBeVisible()
    await expect(page.locator('[data-testid="bundle-install-stats"]')).toHaveCount(0)

    await installsTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/installs(?:\?|$)/)
    await expect(installsTab).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-testid="bundle-install-stats"]')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Bundle install performance' })).toBeVisible()

    await activeBundleTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/active-bundle(?:\?|$)/)
    await expect(activeBundleTab).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Active bundle' })).toBeVisible()
    await expect(page.locator('[data-testid="bundle-install-stats"]')).toHaveCount(0)
  })

  test('native, installs, and active bundle default to the 1 day period', async ({ page }) => {
    function assertDayWindow(url: URL, days: number) {
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      expect(from).toBeTruthy()
      expect(to).toBeTruthy()
      const fromDate = new Date(`${from}T00:00:00.000Z`)
      const toDate = new Date(`${to}T00:00:00.000Z`)
      const daySpan = Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000))
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
      expect(toDate.getTime()).toBeGreaterThanOrEqual(twoDaysAgo)
      expect(toDate.getTime()).toBeLessThanOrEqual(Date.now())
      expect(daySpan).toBe(days - 1)
    }

    const oneDayButton = (locator = page.locator('[data-testid="period-day-selector"]')) =>
      locator.getByRole('button', { name: '1 day', exact: true })

    const nativeRequest = page.waitForRequest(request => request.url().includes('/native_usage?'))
    await page.goto('/app/com.demo.app/native')
    assertDayWindow(new URL((await nativeRequest).url()), 1)
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    await page.goto('/app/com.demo.app/installs')
    await expect(page.locator('[data-testid="period-day-selector"]')).toBeVisible()
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    const bundleRequest = page.waitForRequest(request => request.url().includes('/bundle_usage?'))
    await page.goto('/app/com.demo.app/active-bundle')
    assertDayWindow(new URL((await bundleRequest).url()), 1)
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    const maxRequest = page.waitForRequest(request => request.url().includes('/bundle_usage?'))
    await page.locator('[data-testid="period-day-selector"]').getByRole('button', { name: 'Max', exact: true }).click()
    assertDayWindow(new URL((await maxRequest).url()), 30)
  })
})
