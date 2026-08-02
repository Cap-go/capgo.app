import { getDailyPromoVariant, getUtcPromoDay } from '../../src/services/prioritySupportPromo'
import { expect, test } from '../support/commands'

function getSupportPromoTime() {
  const start = new Date('2026-01-01T12:00:00.000Z')
  for (let day = 0; day < 366; day += 1) {
    const candidate = new Date(start)
    candidate.setUTCDate(start.getUTCDate() + day)
    if (getDailyPromoVariant(getUtcPromoDay(candidate)) === 'support')
      return candidate
  }
  throw new Error('Daily promo selection did not produce a support day')
}

test.describe('Priority plugin support', () => {
  test.beforeEach(async ({ page }) => {
    await page.login('test@capgo.app', 'testtest')
  })

  test('links GitHub from the priority-support presentation', async ({ page }) => {
    const supportTime = getSupportPromoTime()
    await page.clock.setFixedTime(supportTime)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/app/com.demo.app')

    const banner = page.getByRole('button', { name: /Priority help for Capgo plugins/ })
    await expect(banner).toBeVisible()
    const overflowBefore = await page.locator('body').evaluate(body => body.style.overflow)
    await banner.click()

    const presentation = page.getByRole('dialog')
    const progress = presentation.getByRole('progressbar')
    const slides = presentation.locator('.ps-slide')
    const shownIndexes = () => slides.evaluateAll(elements => elements
      .flatMap((element, index) => element.classList.contains('show') ? [index] : []))
    const visibleIndexes = () => slides.evaluateAll(elements => elements
      .map((element, index) => ({ index, style: getComputedStyle(element) }))
      .filter(({ style }) => style.visibility !== 'hidden' && Number(style.opacity) > 0.99)
      .map(({ index }) => index))
    await expect(progress).toHaveAttribute('aria-valuenow', '1')

    const nextButton = presentation.getByRole('button', { name: /^Next/ })
    await expect(nextButton).toBeVisible()
    await page.clock.pauseAt(supportTime)
    await nextButton.evaluate(button => (button as HTMLButtonElement).click())
    expect(await shownIndexes()).toEqual([0, 1])
    expect(await visibleIndexes()).toEqual([0, 1])
    expect(await progress.getAttribute('aria-valuenow')).toBe('2')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(shownIndexes).toEqual([1])
    await expect.poll(visibleIndexes).toEqual([1])
    await expect(slides.nth(0)).toHaveAttribute('aria-hidden', 'true')
    await expect(slides.nth(1)).toHaveAttribute('aria-hidden', 'false')
    await expect(slides.nth(2)).toHaveAttribute('aria-hidden', 'true')
    await page.clock.resume()

    await presentation.locator('.ps-x').click()
    await expect(presentation).toBeHidden()
    expect(await page.locator('body').evaluate(body => body.style.overflow)).toBe(overflowBefore)

    await banner.click()
    await expect(progress).toHaveAttribute('aria-valuenow', '1')
    await presentation.getByRole('button', { name: /^Next/ }).click()
    await presentation.getByRole('button', { name: /^Next/ }).click()
    await expect(progress).toHaveAttribute('aria-valuenow', '3')
    await presentation.getByRole('button', { name: 'Link your GitHub account', exact: true }).click()

    await expect(page).toHaveURL(/\/settings\/account$/)
    await expect(page.getByRole('heading', { name: 'GitHub username', exact: true })).toBeVisible()
    await expect(page.locator('#github-username-input')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'GitHub username', exact: true })).not.toBeVisible()
  })
})
