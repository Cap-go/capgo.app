import type { Page } from '@playwright/test'

function isTimeoutError(error: unknown) {
  return error instanceof Error && error.name === 'TimeoutError'
}

export async function dismissSupportPrompt(page: Page) {
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
