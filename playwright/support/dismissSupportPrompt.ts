import type { Page } from '@playwright/test'

// The demo identity from supabase/seed.sql; keep browser helpers free of stack startup.
export const DEMO_USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'
export const DEMO_USER_EMAIL = 'test@capgo.app'

/** Same key as src/services/supportUsernamesPrompt.ts; a recent value hides the prompt for a week. */
export async function markSupportPromptShown(page: Page, userId = DEMO_USER_ID) {
  await page.evaluate((id) => {
    localStorage.setItem(`capgo.supportUsernames.lastShown.${id}`, new Date().toISOString())
  }, userId)
}

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
