import type { Page } from '@playwright/test'
// The demo identity from supabase/seed.sql; keep browser helpers free of stack startup.
const USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'

export async function dismissSupportPrompt(page: Page, userId = USER_ID) {
  // Loading organizations can delay the prompt beyond the initial visibility wait.
  await page.evaluate((id) => {
    localStorage.setItem(`capgo.supportUsernames.lastShown.${id}`, new Date().toISOString())
  }, userId)
  const prompt = page.locator('[data-test="support-usernames-prompt"]')
  if (!await prompt.isVisible())
    return
  await prompt.locator('[data-test="support-usernames-remind-later"]').click()
  await prompt.waitFor({ state: 'hidden' })
}
