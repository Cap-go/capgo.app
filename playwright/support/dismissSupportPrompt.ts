import type { Page } from '@playwright/test'

export async function dismissSupportPrompt(page: Page) {
  const prompt = page.locator('[data-test="support-usernames-prompt"]')
  try {
    await prompt.waitFor({ state: 'visible', timeout: 4000 })
  }
  catch {
    return
  }
  await prompt.getByRole('button', { name: /remind me later/i }).click()
  await prompt.waitFor({ state: 'hidden' })
}
