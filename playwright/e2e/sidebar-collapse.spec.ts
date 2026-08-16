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

async function orgSwitcherMenuIsOnTop(page: Page) {
  const menu = page.locator('[data-test="org-switcher-menu"]')
  await expect(menu).toBeVisible()
  await expect.poll(async () => {
    return menu.evaluate((el) => {
      const style = getComputedStyle(el)
      return `${style.position}:${style.display}`
    })
  }).toMatch(/^(absolute|fixed):(?!none).+/)
  const menuBox = await menu.boundingBox()
  expect(menuBox).toBeTruthy()
  expect(menuBox!.width).toBeGreaterThanOrEqual(280)
  expect(menuBox!.height).toBeGreaterThan(80)
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el?.closest('[data-test="org-switcher-menu"]') != null
  }, { x: menuBox!.x + Math.min(40, menuBox!.width / 2), y: menuBox!.y + 24 })
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
    await expect(page.locator('[data-test="org-switcher-menu"]')).toContainText(/add organization/i)
    expect(await orgSwitcherMenuIsOnTop(page)).toBe(true)

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

  test('keeps the collapsed org switcher above app dashboard tabs', async ({ page }) => {
    await page.locator('[data-test="sidebar-collapse-toggle"]').click()
    await page.goto('/app/com.demo.app')
    await dismissSupportPrompt(page)
    await expect(page.locator('[data-test="org-switcher"]')).toBeVisible()
    await page.locator('[data-test="org-switcher"] summary').click()
    await expect(page.locator('[data-test="org-switcher-menu"]')).toHaveCSS('position', 'fixed')
    expect(await orgSwitcherMenuIsOnTop(page)).toBe(true)
  })
})
