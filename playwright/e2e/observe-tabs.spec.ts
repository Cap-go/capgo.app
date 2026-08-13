import { expect, test } from '../support/commands'

test.describe('Observe sections', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('keeps Observe subtabs reachable on desktop and mobile', async ({ page }) => {
    await page.goto('/app/com.demo.app/observe/updater')

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

    await nativeTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/native(?:\?|$)/)
    await expect(nativeTab).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Observe', exact: true, level: 1 })).toBeVisible()
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
  })
})
