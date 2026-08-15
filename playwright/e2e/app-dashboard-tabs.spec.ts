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

  test('native and active bundle charts request the last 30 days ending today', async ({ page }) => {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setUTCDate(start.getUTCDate() - 29)
    const expectedFrom = start.toISOString().slice(0, 10)
    const expectedTo = today.toISOString().slice(0, 10)

    const nativeRequest = page.waitForRequest(request => request.url().includes('/native_usage?'))
    await page.goto('/app/com.demo.app/native')
    const nativeUrl = new URL((await nativeRequest).url())
    expect(nativeUrl.searchParams.get('from')).toBe(expectedFrom)
    expect(nativeUrl.searchParams.get('to')).toBe(expectedTo)

    const bundleRequest = page.waitForRequest(request => request.url().includes('/bundle_usage?'))
    await page.goto('/app/com.demo.app/active-bundle')
    const bundleUrl = new URL((await bundleRequest).url())
    expect(bundleUrl.searchParams.get('from')).toBe(expectedFrom)
    expect(bundleUrl.searchParams.get('to')).toBe(expectedTo)
  })
})
