import { expect, test } from '../support/commands'

const TEST_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'

test.describe('App dashboard sections', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
    await page.evaluate((userId) => {
      localStorage.setItem(`capgo.supportUsernames.dismissed.${userId}`, '1')
    }, TEST_USER_ID)
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
    function assertDayWindow(from: string | null, to: string | null, days: number) {
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
    const nativeUrl = new URL((await nativeRequest).url())
    assertDayWindow(nativeUrl.searchParams.get('from'), nativeUrl.searchParams.get('to'), 1)
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    await page.goto('/app/com.demo.app/installs')
    await expect(page.locator('[data-testid="period-day-selector"]')).toBeVisible()
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    const bundleRequest = page.waitForRequest(request => request.url().includes('/bundle_usage?'))
    await page.goto('/app/com.demo.app/active-bundle')
    const bundleUrl = new URL((await bundleRequest).url())
    assertDayWindow(bundleUrl.searchParams.get('from'), bundleUrl.searchParams.get('to'), 1)
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    const maxButton = page.locator('[data-testid="period-day-selector"]').getByRole('button', { name: 'Max', exact: true })
    const range = page.locator('[data-testid="version-chart-range"]')
    await maxButton.click()
    await expect(maxButton).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => {
      const from = await range.getAttribute('data-from')
      const to = await range.getAttribute('data-to')
      if (!from || !to)
        return -1
      const fromDate = new Date(`${from}T00:00:00.000Z`)
      const toDate = new Date(`${to}T00:00:00.000Z`)
      return Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000))
    }).toBe(29)
    assertDayWindow(await range.getAttribute('data-from'), await range.getAttribute('data-to'), 30)
  })
})
