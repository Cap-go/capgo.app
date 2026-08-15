import type { Page } from '@playwright/test'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

async function shellPadding(page: Page) {
  return page.locator('[data-test="dashboard-shell"]').evaluate((el) => {
    const style = getComputedStyle(el)
    return `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom}`
  })
}

test.describe('Desktop sidebar collapse', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
    await page.goto('/apps')
    await dismissSupportPrompt(page)
    await expect(page.locator('#sidebar')).toBeVisible()
  })

  test('collapses the desktop sidebar, gutters, and keeps the org switcher', async ({ page }) => {
    await expect(page.locator('[data-test="sidebar-collapse-toggle"]')).toBeVisible()
    await expect(page.locator('[data-test="sidebar-mobile-toggle"]')).toBeHidden()
    await expect.poll(() => shellPadding(page)).toBe('12px 12px 12px')

    await page.locator('[data-test="sidebar-collapse-toggle"]').click()

    await expect(page.locator('#sidebar')).toBeHidden()
    await expect(page.locator('[data-test="org-switcher"]')).toBeVisible()
    await expect.poll(() => shellPadding(page)).toBe('0px 0px 0px')

    await page.locator('[data-test="org-switcher"] summary').click()
    await expect(page.locator('[data-test="org-switcher-menu"]')).toBeVisible()
    await expect(page.locator('[data-test="org-switcher-menu"]')).toContainText(/add organization/i)

    await page.reload()
    await dismissSupportPrompt(page)
    await expect(page.locator('#sidebar')).toBeHidden()
    await expect(page.locator('[data-test="org-switcher"]')).toBeVisible()

    await page.locator('[data-test="sidebar-collapse-toggle"]').click()
    await expect(page.locator('#sidebar')).toBeVisible()
    await expect.poll(() => shellPadding(page)).toBe('12px 12px 12px')
  })

  test('keeps the mobile overlay sidebar when the viewport is small', async ({ page }) => {
    await page.locator('[data-test="sidebar-collapse-toggle"]').click()
    await expect(page.locator('#sidebar')).toBeHidden()

    await page.setViewportSize({ width: 375, height: 667 })

    await expect(page.locator('[data-test="sidebar-collapse-toggle"]')).toBeHidden()
    await expect(page.locator('[data-test="sidebar-mobile-toggle"]')).toBeVisible()
    await expect(page.locator('#sidebar')).not.toBeInViewport()

    await page.locator('[data-test="sidebar-mobile-toggle"]').click()
    await expect(page.locator('#sidebar')).toBeInViewport()
    await expect(page.locator('#sidebar')).toContainText(/pages/i)
    await expect(page.locator('[data-test="org-switcher"]')).toBeVisible()
  })
})
