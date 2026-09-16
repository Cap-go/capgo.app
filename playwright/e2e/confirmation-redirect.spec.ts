import type { Route } from '@playwright/test'
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

  test('keeps verification navigation when a background import is cancelled', async ({ page }) => {
    const navigations: string[] = []
    page.on('request', (request) => {
      if (request.isNavigationRequest())
        navigations.push(new URL(request.url()).pathname)
    })
    let reportImportError!: (state: { reloadTimestamp: string | null, loaderVisible: boolean, confirmationRendered: boolean }) => void
    const importError = new Promise<Parameters<typeof reportImportError>[0]>((resolve) => {
      reportImportError = resolve
    })
    await page.exposeFunction('reportCancelledImport', reportImportError)
    await page.addInitScript(() => {
      window.addEventListener('unhandledrejection', () => {
        queueMicrotask(() => {
          const loader = document.querySelector('#app-loader')
          const report = Reflect.get(window, 'reportCancelledImport')
          void report({
            reloadTimestamp: sessionStorage.getItem('capgo_chunk_reload_timestamp'),
            loaderVisible: !!loader && getComputedStyle(loader).visibility === 'visible',
            confirmationRendered: !!document.querySelector('h2'),
          }).catch(() => {})
        })
      }, { capture: true, once: true })
      const modulePath = '/cancelled-background-import.js'
      void import(modulePath)
    })
    let captureBackgroundRequest!: (route: Route) => void
    const backgroundRequest = new Promise<Route>((resolve) => {
      captureBackgroundRequest = resolve
    })
    await page.route('**/cancelled-background-import.js', captureBackgroundRequest)
    let finishVerification!: () => void
    const verificationPending = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    await page.route('**/auth/v1/verify?**', async (route) => {
      const background = await backgroundRequest
      await background.abort('aborted').catch(() => {})
      await verificationPending
      await route.fulfill({ contentType: 'text/html', body: '<p>Verification endpoint</p>' }).catch(() => {})
    })
    const query = new URLSearchParams({
      confirmation_url: 'https://127.0.0.1/auth/v1/verify?token=cancelled-import-regression',
      type: 'recovery',
    })
    const verificationRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/v1/verify')
    await page.goto(`/confirm-signup?${query}`, { waitUntil: 'commit' })
    await verificationRequest

    try {
      const state = await importError
      expect(state.reloadTimestamp).toBeNull()
      expect(state.loaderVisible).toBe(true)
      expect(state.confirmationRendered).toBe(false)
    }
    finally {
      finishVerification()
    }
    await expect(page.getByText('Verification endpoint')).toBeVisible()
    expect(navigations).toEqual(['/confirm-signup', '/auth/v1/verify'])
  })

  test('keeps invalid link errors and genuine stale asset recovery working', async ({ page }) => {
    const query = new URLSearchParams({ confirmation_url: 'https://untrusted.example/auth/v1/verify?token=invalid-link-regression' })
    await page.goto(`/confirm-signup?${query}`)
    await expect(page.getByText('Invalid confirmation URL. Please check your email link.')).toBeVisible()
    await page.route('**/missing-background-import.js', route => route.fulfill({
      status: 404,
      contentType: 'text/html',
      body: '<p>Old asset removed</p>',
    }))
    const reload = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === '/confirm-signup')
    await page.evaluate(() => {
      const modulePath = '/missing-background-import.js'
      void import(modulePath)
    })
    await reload
    await expect(page.getByText('Invalid confirmation URL. Please check your email link.')).toBeVisible()
    await expect(page.getByText('App updated! Page was refreshed to load the latest version.')).toBeVisible()
  })
})
