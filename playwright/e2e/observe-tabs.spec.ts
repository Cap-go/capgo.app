import { expect, test } from '../support/commands'

test.describe('Observe sections', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('keeps Global and Plugins reachable on desktop and mobile', async ({ page }) => {
    await page.goto('/app/com.demo.app/observe')

    const globalTab = page.getByRole('button', { name: 'Global', exact: true })
    const pluginsTab = page.getByRole('button', { name: 'Plugins', exact: true })

    await expect(globalTab).toBeVisible()
    await expect(pluginsTab).toBeVisible()
    await expect(globalTab).toHaveAttribute('aria-current', 'page')

    await pluginsTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe\/plugins$/)
    await expect(pluginsTab).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-test="observe-plugin-insights"]')).toBeVisible()
    await expect(page.locator('[data-test="observe-plugin-insights"] table').getByText('4.15.3', { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 375, height: 667 })
    await expect(globalTab).toBeVisible()
    await expect(pluginsTab).toBeVisible()

    const globalBox = await globalTab.boundingBox()
    const pluginsBox = await pluginsTab.boundingBox()
    expect(globalBox?.x).toBeGreaterThanOrEqual(0)
    expect((pluginsBox?.x ?? 0) + (pluginsBox?.width ?? 0)).toBeLessThanOrEqual(375)

    await globalTab.click()
    await expect(page).toHaveURL(/\/app\/com\.demo\.app\/observe$/)
    await expect(page.getByRole('heading', { name: 'All versions summary', exact: true })).toBeVisible()
  })
})
