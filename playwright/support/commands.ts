import { test as base, expect } from '@playwright/test'

// Extend basic test fixture
export const test = base.extend({
  // Add custom commands here
  page: async ({ page }, use) => {
    // Add custom commands to page
    page.login = async (email: string, password: string) => {
      await page.goto('/login/')
      await page.fill('[data-test="email"]', email)
      await page.click('[data-test="continue"]')
      await page.waitForSelector('[data-test="password"]')
      await page.fill('[data-test="password"]', password)
      const submit = page.locator('[data-test="submit"]')
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await submit.isEnabled()) {
          await submit.click()
        }
        else {
          // Some environments keep captcha-gated login buttons disabled in UI automation.
          // Fall back to a direct form submit if available.
          const form = page.locator('form')
          const formCount = await form.count()
          if (formCount > 0)
            await form.first().evaluate((el: HTMLFormElement) => el.requestSubmit())
          else
            await page.keyboard.press('Enter')
        }

        try {
          await page.waitForURL(/\/(apps|dashboard)(\/|$)/, { timeout: attempt === 2 ? 30000 : 10000 })
          return
        }
        catch (error) {
          const formError = await page.locator('[data-test="form-error"]').textContent({ timeout: 1000 }).catch(() => '')
          if (!formError?.includes('schema cache') || attempt === 2)
            throw error
          await page.waitForTimeout(1000)
        }
      }
    }

    await use(page)
  },
})

export { expect }
