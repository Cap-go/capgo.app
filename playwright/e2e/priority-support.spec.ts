import { expect, test } from '../support/commands'

test.describe('Priority plugin support', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('links GitHub from the priority-support presentation', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-02T12:00:00.000Z'))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/app/com.demo.app')

    const banner = page.getByRole('button', { name: /Priority help for Capgo plugins/ })
    await expect(banner).toBeVisible()
    const overflowBefore = await page.locator('body').evaluate(body => body.style.overflow)
    await banner.click()

    const presentation = page.getByRole('dialog')
    const progress = presentation.getByRole('progressbar')
    const slides = presentation.locator('.ps-slide')
    await expect(progress).toHaveAttribute('aria-valuenow', '1')

    await presentation.getByRole('button', { name: /^Next/ }).click()
    await expect(progress).toHaveAttribute('aria-valuenow', '2')
    expect(await slides.evaluateAll(elements => elements
      .map((element, index) => ({ index, style: getComputedStyle(element) }))
      .filter(({ style }) => style.visibility !== 'hidden' && Number(style.opacity) > 0.99)
      .map(({ index }) => index))).toEqual([1])

    await presentation.locator('.ps-x').click()
    await expect(presentation).toBeHidden()
    expect(await page.locator('body').evaluate(body => body.style.overflow)).toBe(overflowBefore)

    await banner.click()
    await expect(progress).toHaveAttribute('aria-valuenow', '1')
    await presentation.getByRole('button', { name: /^Next/ }).click()
    await presentation.getByRole('button', { name: /^Next/ }).click()
    await expect(progress).toHaveAttribute('aria-valuenow', '3')
    await presentation.getByRole('button', { name: 'Link your GitHub account', exact: true }).click()

    await expect(page).toHaveURL(/\/settings\/account\?(?=[^#]*from=priority-support)(?=[^#]*tab=profile)(?![^#]*connect=github)/)
    await expect(page.getByRole('heading', { name: 'GitHub username', exact: true })).toBeVisible()
    await expect(page.locator('#github-username-input')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'GitHub username', exact: true })).not.toBeVisible()
  })
})
