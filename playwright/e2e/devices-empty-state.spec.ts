import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/commands'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const APP_ID = 'com.demo.app'
const TEST_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'

async function mockEmptyDevices(page: Page, requests: Record<string, unknown>[]) {
  await page.route('**/private/devices**', async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    requests.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body.count
        ? { count: 0 }
        : { data: [], hasMore: false }),
    })
  })
}

async function expectRequestCountToStabilize(requests: Record<string, unknown>[]) {
  let lastCount = -1
  let stableSince = 0
  await expect.poll(() => {
    const count = requests.length
    if (count !== lastCount) {
      lastCount = count
      stableSince = Date.now()
      return 'waiting'
    }
    if (Date.now() - stableSince < 1500)
      return 'waiting'
    return 'stable'
  }, { timeout: 5000, intervals: [100] }).toBe('stable')
}

test.describe('Devices empty state', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/private/sso/check-enforcement**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    })
    await page.login('test@capgo.app', 'testtest')
    await page.evaluate((userId) => {
      localStorage.setItem(`capgo.supportUsernames.dismissed.${userId}`, '1')
    }, TEST_USER_ID)
  })

  test('explains why devices may be missing and exposes inline actions', async ({ page }) => {
    const requests: Record<string, unknown>[] = []
    await mockEmptyDevices(page, requests)
    await page.goto(`/app/${APP_ID}/devices`)

    const emptyState = page.locator('[data-test="devices-empty-state"]')
    await expect(emptyState.getByRole('heading', { name: 'No devices found' })).toBeVisible()
    await expect(page.locator('[data-test="devices-range-filter-banner"]')).toHaveCount(0)
    await expect(emptyState.getByText('The selected time range is too narrow.')).toBeVisible()
    await expect(emptyState.getByText('The app hasn’t contacted Capgo yet.')).toBeVisible()
    await expect(emptyState.getByText('The device contacted Capgo after this page loaded.')).toBeVisible()
    await expect(emptyState.getByText('Search or filters are hiding it.')).toHaveCount(0)
    await expect(page.getByText('No elements found')).toHaveCount(0)

    const changeTimeRange = emptyState.getByRole('button', { name: 'Change time range' })
    await changeTimeRange.click()
    await expect(page.getByRole('dialog', { name: /Date range:/ })).toBeVisible()
    await changeTimeRange.click()
    await expect(page.getByRole('dialog', { name: /Date range:/ })).toHaveCount(0)

    await changeTimeRange.press('Enter')
    await expect(page.getByRole('dialog', { name: /Date range:/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(changeTimeRange).toBeFocused()

    const search = page.getByPlaceholder('Search by device ID or Custom ID')
    await search.fill('missing-device')
    await expect.poll(() => requests.at(-1)?.search).toBe('missing-device')
    await expectRequestCountToStabilize(requests)
    const requestCountBeforeRefresh = requests.length
    await emptyState.getByRole('button', { name: 'Refresh devices' }).click()
    await expect.poll(() => requests.length).toBeGreaterThan(requestCountBeforeRefresh)
    await expectRequestCountToStabilize(requests)
    await expect.poll(() => requests.at(-1)).toMatchObject({
      appId: APP_ID,
      search: 'missing-device',
    })
    expect(requests.at(-1)).toHaveProperty('updated_at_gt')
    expect(requests.at(-1)).toHaveProperty('updated_at_lte')
  })

  test('shows and clears the active search and device filters with one reload', async ({ page }) => {
    const requests: Record<string, unknown>[] = []
    await mockEmptyDevices(page, requests)
    await page.goto(`/app/${APP_ID}/devices`)

    const search = page.getByPlaceholder('Search by device ID or Custom ID')
    await search.fill('missing-device')
    await page.locator('[data-test="data-table-filters-open"]').click()
    await page.locator('[data-test="device-platform-ios"]').click()
    const bundleSearch = page.locator('[data-test="device-bundle-filter-search"]')
    await bundleSearch.fill('1.0.0')
    await bundleSearch.press('Enter')
    await expect(page.locator('[data-test="device-bundle-filter-chips"]')).toContainText('1.0.0')
    await page.getByLabel('Override').check()
    await page.getByLabel('CustomId').check()
    await page.locator('[data-test="data-table-filters-done"]').click()

    const emptyState = page.locator('[data-test="devices-empty-state"]')
    await expect(emptyState.getByText('Search or filters are hiding it.')).toBeVisible()
    const requestCountBeforeClear = requests.length

    await emptyState.getByRole('button', { name: 'Clear filters' }).click()

    await expect(search).toHaveValue('')
    await expect(emptyState.getByText('Search or filters are hiding it.')).toHaveCount(0)
    await expect.poll(() => requests.length).toBeGreaterThan(requestCountBeforeClear)
    await expectRequestCountToStabilize(requests)
    await expect.poll(() => requests.at(-1)).toMatchObject({
      appId: APP_ID,
      customIdMode: false,
    })
    expect(requests.at(-1)).not.toHaveProperty('search')
    expect(requests.at(-1)).not.toHaveProperty('platform')
    expect(requests.at(-1)).not.toHaveProperty('versionNames')
    expect(requests.at(-1)).not.toHaveProperty('versionName')
  })

  test('shows how many devices the time range is hiding', async ({ page }) => {
    await page.route('**/private/devices**', async (route: Route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      const filtered = 'updated_at_gt' in body
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body.count
          ? { count: filtered ? 0 : 3 }
          : { data: [], hasMore: false }),
      })
    })
    await page.goto(`/app/${APP_ID}/devices`)

    const banner = page.locator('[data-test="devices-range-filter-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('3 devices are hidden by the current timeframe.')
    await expect(banner.getByRole('button', { name: 'Change the timeframe' })).toBeVisible()
    await expect(page.locator('[data-test="devices-empty-state"]')).toBeVisible()

    await banner.getByRole('button', { name: 'Change the timeframe' }).click()
    await expect(page.getByRole('dialog', { name: /Date range:/ })).toBeVisible()
  })
})
