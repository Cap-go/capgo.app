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

async function expectRequestCountToRemain(requests: Record<string, unknown>[], expected: number) {
  const stableAfter = Date.now() + 1100
  await expect.poll(() => {
    if (requests.length !== expected)
      return `unexpected:${requests.length}`
    return Date.now() >= stableAfter ? 'stable' : 'waiting'
  }, { timeout: 2000, intervals: [100] }).toBe('stable')
}

test.describe('Devices empty state', () => {
  test.beforeEach(async ({ page }) => {
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
    await expect(emptyState.getByText('The selected time range is too narrow.')).toBeVisible()
    await expect(emptyState.getByText('The app hasn’t contacted Capgo yet.')).toBeVisible()
    await expect(emptyState.getByText('The device contacted Capgo after this page loaded.')).toBeVisible()
    await expect(emptyState.getByText('Search or filters are hiding it.')).toHaveCount(0)
    await expect(page.getByText('No elements found')).toHaveCount(0)

    await emptyState.getByRole('button', { name: 'Change time range' }).press('Enter')
    await expect(page.getByRole('dialog', { name: /Date range:/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(emptyState.getByRole('button', { name: 'Change time range' })).toBeFocused()

    const search = page.getByPlaceholder('Search by device ID or Custom ID')
    await search.fill('missing-device')
    await expect.poll(() => requests.at(-1)?.search).toBe('missing-device')
    const requestCountBeforeRefresh = requests.length
    await emptyState.getByRole('button', { name: 'Refresh devices' }).click()
    await expect.poll(() => requests.length).toBe(requestCountBeforeRefresh + 2)
    await expectRequestCountToRemain(requests, requestCountBeforeRefresh + 2)
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
    await page.locator('[data-test="device-bundle-filter"]').fill('1.0.0')
    await page.getByLabel('Override').check()
    await page.getByLabel('CustomId').check()
    await page.locator('[data-test="data-table-filters-done"]').click()

    const emptyState = page.locator('[data-test="devices-empty-state"]')
    await expect(emptyState.getByText('Search or filters are hiding it.')).toBeVisible()
    const requestCountBeforeClear = requests.length

    await emptyState.getByRole('button', { name: 'Clear filters' }).click()

    await expect(search).toHaveValue('')
    await expect(emptyState.getByText('Search or filters are hiding it.')).toHaveCount(0)
    await expect.poll(() => requests.length).toBe(requestCountBeforeClear + 2)
    await expectRequestCountToRemain(requests, requestCountBeforeClear + 2)
    await expect.poll(() => requests.at(-1)).toMatchObject({
      appId: APP_ID,
      customIdMode: false,
    })
    expect(requests.at(-1)).not.toHaveProperty('search')
    expect(requests.at(-1)).not.toHaveProperty('platform')
    expect(requests.at(-1)).not.toHaveProperty('versionName')
  })
})
