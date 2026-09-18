import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const fixture = '/playwright/fixtures/email-verification.html?reason=email_not_verified&return_to=/settings/account'

async function sendCode(page: Page) {
  const captcha = page.getByRole('checkbox', { name: 'Verify you are human' })
  // CI disables CAPTCHA; local runs also exercise the fixture widget when enabled.
  if (await captcha.count())
    await captcha.check()
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click()
}

test.describe('Progressive email verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixture)
    await expect(page.getByRole('heading', { name: 'Verify your email', exact: true })).toBeVisible()
  })

  test('reveals and focuses code entry only after a successful send, then verifies with Enter', async ({ page }) => {
    const code = page.getByLabel('Enter the verification code', { exact: true })
    await expect(code).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Validate email and continue' })).toHaveCount(0)
    await page.evaluate(() => (window as any).emailVerificationPreview.sendDelayMs = 500)
    await sendCode(page)
    await expect(code).toHaveCount(0)
    await expect(code).toBeVisible()
    await expect(code).toBeFocused()
    await expect(page.getByRole('button', { name: 'Send verification code', exact: true })).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: 'Verify you are human' })).toHaveCount(0)

    await page.evaluate(() => (window as any).emailVerificationPreview.verificationError = true)
    await code.fill('000000')
    await code.press('Enter')
    await expect(page.getByText('Verification failed', { exact: true })).toBeVisible()
    await expect(code).toBeVisible()
    await page.evaluate(() => (window as any).emailVerificationPreview.verificationError = false)
    await code.fill('123456')
    await code.press('Enter')
    await expect(page).toHaveURL('/settings/account')
  })

  test('keeps the send step on failure and permits retrying', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).emailVerificationPreview.sendError = { code: 'unexpected_failure', message: 'Unable to send', status: 500 }
    })
    await sendCode(page)
    await expect(page.getByRole('alert')).toHaveText('Could not send the verification code. Please try again.')
    await expect(page.getByLabel('Enter the verification code', { exact: true })).toHaveCount(0)
    await page.evaluate(() => (window as any).emailVerificationPreview.sendError = null)
    await sendCode(page)
    await expect(page.getByLabel('Enter the verification code', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as any).emailVerificationPreview.sends.length)).toBe(2)
  })

  test('returns to the CAPTCHA step to resend and allows returning to the existing code', async ({ page }) => {
    await sendCode(page)
    const code = page.getByLabel('Enter the verification code', { exact: true })
    await code.fill('123456')
    await page.getByRole('button', { name: 'Send another code', exact: true }).click()
    await expect(code).toBeHidden()
    const captcha = page.getByRole('checkbox', { name: 'Verify you are human' })
    if (await captcha.count()) {
      await expect(captcha).not.toBeChecked()
      await expect(page.getByRole('button', { name: 'Send verification code', exact: true })).toBeDisabled()
    }
    await page.getByRole('button', { name: 'Back to code entry', exact: true }).click()
    await expect(code).toHaveValue('123456')
    await page.getByRole('button', { name: 'Send another code', exact: true }).click()
    await sendCode(page)
    await expect(code).toHaveValue('')
  })
})
