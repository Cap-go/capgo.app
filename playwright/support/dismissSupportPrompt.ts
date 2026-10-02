import type { Page } from '@playwright/test'
import { USER_ID } from '../../tests/test-utils'

function isTimeoutError(error: unknown) {
  return error instanceof Error && error.name === 'TimeoutError'
}

export async function dismissSupportPrompt(page: Page, userId = USER_ID) {
  // Loading organizations can delay the prompt beyond the initial visibility wait.
  await page.evaluate((id) => {
    localStorage.setItem(`capgo.supportUsernames.lastShown.${id}`, new Date().toISOString())
  }, userId)
  const prompt = page.locator('[data-test="support-usernames-prompt"]')
  try {
    await prompt.waitFor({ state: 'visible', timeout: 4000 })
  }
  catch (error) {
    if (isTimeoutError(error))
      return
    throw error
  }
  await prompt.locator('[data-test="support-usernames-remind-later"]').click()
  await prompt.waitFor({ state: 'hidden' })
}
