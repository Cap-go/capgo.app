import { expect, test } from '../support/commands'

test.describe('Auth email confirmation redirects', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/auth/v1/verify?**', route => route.fulfill({
      contentType: 'text/html',
      body: '<p>Verification endpoint</p>',
    }))
  })

  test('restores recovery parameters from a tracked email link', async ({ page }) => {
    const verificationUrl = 'https://127.0.0.1/auth/v1/verify?token=password-reset-regression'
    const redirectTo = new URL('/forgot_password?step=2', test.info().project.use.baseURL).href
    const query = new URLSearchParams({
      confirmation_url: verificationUrl,
      type: 'recovery',
      redirect_to: redirectTo,
      utm_source: 'bento',
    })
    const requestPromise = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === '/auth/v1/verify')

    await page.goto(`/confirm-signup?${query}`)
    const request = await requestPromise
    const target = new URL(request.url())

    expect(target.searchParams.get('token')).toBe('password-reset-regression')
    expect(target.searchParams.get('type')).toBe('recovery')
    expect(target.searchParams.get('redirect_to')).toBe(redirectTo)
    expect(target.searchParams.has('utm_source')).toBe(false)
    await expect(page.getByText('Verification endpoint')).toBeVisible()
  })

  test('preserves query parameters inside a fully encoded recovery link', async ({ page }) => {
    const redirectTo = new URL('/forgot_password?step=2&source=email', test.info().project.use.baseURL).href
    const verificationUrl = new URL('https://127.0.0.1/auth/v1/verify')
    verificationUrl.search = new URLSearchParams({ token: 'password-reset-regression', type: 'recovery', redirect_to: redirectTo }).toString()
    const query = new URLSearchParams({ confirmation_url: verificationUrl.href })
    const requestPromise = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === '/auth/v1/verify')

    await page.goto(`/confirm-signup?${query}`)
    const request = await requestPromise

    expect(new URL(request.url()).searchParams.get('redirect_to')).toBe(redirectTo)
    await expect(page.getByText('Verification endpoint')).toBeVisible()
  })
})
