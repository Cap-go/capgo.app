import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

test.describe('Observe sections', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('keeps Observe subtabs reachable on desktop and mobile', async ({ page }) => {
    await page.goto('/app/com.demo.app/observe/updater')
    // Dismiss support prompt so mobile tab clicks are not intercepted.
    await dismissSupportPrompt(page)

    const updaterTab = page.getByRole('button', { name: 'Updater', exact: true })
    const logsTab = page.getByRole('button', { name: 'Logs', exact: true })
    const nativeTab = page.getByRole('button', { name: 'Native', exact: true })
    const compatibilityTab = page.getByRole('button', { name: 'Compatibility', exact: true })
    const pluginsTab = page.getByRole('button', { name: 'Plugins', exact: true })

    await expect(updaterTab).toBeVisible()
    await expect(logsTab).toBeVisible()
    await expect(nativeTab).toBeVisible()
    await expect(compatibilityTab).toBeVisible()
    await expect(pluginsTab).toBeVisible()
    await expect(updaterTab).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-test="observe-updater-version-filter"]')).toBeVisible()

    await logsTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/logs(?:\?|$)/)
    await expect(logsTab).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#custom_table thead')).toContainText(/action/i)
    await expect(page.locator('#custom_table thead')).not.toContainText(/metadata/i)

    await compatibilityTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/compatibility(?:\?|$)/)
    await expect(compatibilityTab).toHaveAttribute('aria-current', 'page')

    await pluginsTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/plugins(?:\?|$)/)
    await expect(pluginsTab).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-test="observe-plugin-insights"]')).toBeVisible()
    await expect(page.locator('[data-test="observe-plugin-insights"] table').getByText('4.15.3', { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 375, height: 667 })
    await expect(updaterTab).toBeVisible()
    await expect(pluginsTab).toBeVisible()

    const updaterBox = await updaterTab.boundingBox()
    const pluginsBox = await pluginsTab.boundingBox()
    expect(updaterBox?.x).toBeGreaterThanOrEqual(0)
    expect((pluginsBox?.x ?? 0) + (pluginsBox?.width ?? 0)).toBeLessThanOrEqual(375)

    // Dismiss support prompt so mobile tab clicks are not intercepted.
    await dismissSupportPrompt(page)
    await nativeTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/native(?:\?|$)/)
    await expect(nativeTab).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Observe', exact: true, level: 1 })).toBeVisible()
  })

  test('observe updater and native default to 1 day and persist the period in the URL', async ({ page }) => {
    const oneDayButton = () => page.locator('[data-testid="period-day-selector"]').getByRole('button', { name: '1 day', exact: true })
    const sevenDayButton = () => page.locator('[data-testid="period-day-selector"]').getByRole('button', { name: '7 days', exact: true })

    await page.goto('/app/com.demo.app/observe/updater')
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')

    await expect.poll(async () => Number(await page.locator('[data-testid="observe-period-labels"]').getAttribute('data-count'))).toBe(2)

    await sevenDayButton().click()
    await expect(page).toHaveURL(/[?&]days=7(?:&|$)/)
    await expect(sevenDayButton()).toHaveAttribute('aria-pressed', 'true')

    await page.goto('/app/com.demo.app/observe/native')
    await expect(oneDayButton()).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => Number(await page.locator('[data-testid="observe-period-labels"]').getAttribute('data-count'))).toBe(2)
    await sevenDayButton().click()
    await expect(page).toHaveURL(/[?&]days=7(?:&|$)/)
    await expect(sevenDayButton()).toHaveAttribute('aria-pressed', 'true')

    await page.goto('/app/com.demo.app/observe/native?days=3')
    await expect(page.locator('[data-testid="period-day-selector"]').getByRole('button', { name: '3 days', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('shows a metadata info icon only on log rows that have metadata', async ({ page }) => {
    const now = new Date().toISOString()
    await page.route('**/private/stats', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            app_id: 'com.demo.app',
            device_id: '11111111-1111-1111-1111-111111111111',
            action: 'get',
            version_name: '1.0.0',
            created_at: now,
          },
          {
            app_id: 'com.demo.app',
            device_id: '22222222-2222-2222-2222-222222222222',
            action: 'set',
            version_name: '1.0.0',
            created_at: now,
            metadata: { source: 'notify_app_ready' },
          },
        ]),
      })
    })

    await page.goto('/app/com.demo.app/observe/logs')
    await expect(page.locator('#custom_table thead')).toContainText(/action/i)
    await expect(page.locator('#custom_table thead')).not.toContainText(/metadata/i)
    await expect(page.locator('#custom_table tbody tr')).toHaveCount(2)
    const rowWithMetadata = page.locator('#custom_table tbody tr', { hasText: '22222222' })
    const rowWithoutMetadata = page.locator('#custom_table tbody tr', { hasText: '11111111' })
    await expect(rowWithMetadata.locator('[data-test="log-row-metadata"]')).toHaveCount(1)
    await expect(rowWithoutMetadata.locator('[data-test="log-row-metadata"]')).toHaveCount(0)

    await rowWithMetadata.locator('[data-test="log-row-metadata"]').click()
    const popover = page.locator('[data-test="log-row-metadata-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText(/"source"/)
    await expect(popover).toContainText('notify_app_ready')
    await expect(popover.locator('[data-test="log-row-metadata-copy"]')).toBeVisible()

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.body.dataset.copiedLogMetadata = text
          },
        },
      })
    })
    await popover.locator('[data-test="log-row-metadata-copy"]').click()
    await expect.poll(() => page.locator('body').getAttribute('data-copied-log-metadata')).toContain('notify_app_ready')
  })

  test('shows a failed manifest filename in metadata instead of the version column', async ({ page }) => {
    const now = new Date().toISOString()
    await page.route('**/private/stats', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            app_id: 'com.demo.app',
            device_id: 'b3e532e8-256c-4509-b1d4-beec93a71edb',
            action: 'update_fail',
            version_name: '2.36.2+8ebc69',
            created_at: now,
          },
          {
            app_id: 'com.demo.app',
            device_id: '33333333-3333-3333-3333-333333333333',
            action: 'download_manifest_file_fail',
            version_name: '2.36.2+8ebc69:assets/index-8ebc69aabbcc.js',
            created_at: now,
          },
        ]),
      })
    })

    await page.goto('/app/com.demo.app/observe/logs')
    await expect(page.locator('#custom_table tbody tr')).toHaveCount(2)

    const longVersionRow = page.locator('#custom_table tbody tr', { hasText: 'b3e532e8' })
    const manifestFailRow = page.locator('#custom_table tbody tr', { hasText: '33333333' })

    await expect(longVersionRow.locator('[data-test="log-row-version"]')).toHaveText('2.36.2+8ebc69')
    await expect(longVersionRow.locator('[data-test="log-row-action"]')).toHaveText('Update process failed')
    await expect(longVersionRow.locator('[data-test="log-row-metadata"]')).toHaveCount(0)

    const versionBox = await longVersionRow.locator('[data-test="log-row-version"]').boundingBox()
    const actionBox = await longVersionRow.locator('[data-test="log-row-action"]').boundingBox()
    expect(versionBox).toBeTruthy()
    expect(actionBox).toBeTruthy()
    expect((versionBox?.x ?? 0) + (versionBox?.width ?? 0)).toBeLessThanOrEqual((actionBox?.x ?? 0) + 1)

    await expect(manifestFailRow.locator('[data-test="log-row-version"]')).toHaveText('2.36.2+8ebc69')
    await expect(manifestFailRow).not.toContainText('assets/index-8ebc69aabbcc.js')
    await expect(manifestFailRow.locator('[data-test="log-row-metadata"]')).toHaveCount(1)

    await manifestFailRow.locator('[data-test="log-row-metadata"]').click()
    const popover = page.locator('[data-test="log-row-metadata-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText(/"filename"/)
    await expect(popover).toContainText('assets/index-8ebc69aabbcc.js')
  })
})
