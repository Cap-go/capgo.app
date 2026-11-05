import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

const screenshotDir = resolve(process.cwd(), 'docs/pr-screenshots/in-app-billing')
const backupScreenshotDir = resolve(process.cwd(), 'docs/pr-screenshots/backup-card')

// Stripe.js needs a real account, so the screenshots stub its iframes with a labelled placeholder.
// Everything else on screen is real Capgo UI.
const STRIPE_STUB = `
(() => {
  // Mirrors the Payment Element 'night' theme the card form requests in dark mode.
  const dark = () => document.documentElement.classList.contains('dark')
  const field = (label, placeholder, width, light) => {
    const night = !light && dark()
    return '<label style="display:block;flex:' + (width || 1) + ';font:500 13px system-ui;color:' + (night ? '#e2e8f0' : '#30313d') + '">' + label
      + '<div style="margin-top:6px;padding:10px 12px;border:1px solid ' + (night ? '#424770' : '#e0e6eb') + ';border-radius:8px;background:' + (night ? '#30313d' : '#fff') + ';color:#87909f;font:400 15px system-ui">' + placeholder + '</div></label>'
  }
  const note = '<p style="margin:10px 0 0;font:400 11px system-ui;color:#87909f">Stripe secure field (stubbed for screenshot)</p>'
  const cardForm = (light) => '<div style="display:flex;flex-direction:column;gap:12px">'
    + field('Card number', '4242 4242 4242 4242', 1, light)
    + '<div style="display:flex;gap:12px">' + field('Expiration date', '04 / 30', 1, light) + field('Security code', '123', 1, light) + '</div>'
    + field('Country', 'United States', 1, light) + note + '</div>'
  // Embedded Checkout is always light (styled from the Stripe dashboard branding).
  const checkout = () => '<div style="display:flex;gap:32px;padding:28px;font-family:system-ui;color:#1a1a1a;flex-wrap:wrap">'
    + '<div style="flex:1;min-width:220px"><p style="margin:0;color:#6b7280;font-size:14px">Subscribe to Capgo</p>'
    + '<p style="margin:6px 0 0;font-size:34px;font-weight:600">$849.00 <span style="font-size:14px;color:#6b7280;font-weight:400">per month</span></p>'
    + '<p style="margin:18px 0 0;font-size:14px;color:#374151">Plan + extra MAU · billed monthly</p></div>'
    + '<div style="flex:1;min-width:260px;display:flex;flex-direction:column;gap:12px">' + field('Email', 'billing@example.com', 1, true) + cardForm(true)
    + '<div style="margin-top:6px;padding:12px;border-radius:8px;background:#0570de;color:#fff;text-align:center;font:600 15px system-ui">Subscribe</div></div></div>'
  window.Stripe = function () {
    return {
      _registerWrapper() {},
      registerAppInfo() {},
      elements() {
        const handlers = {}
        return {
          getElement() { return null },
          create() {
            return {
              on(event, cb) { handlers[event] = cb },
              mount(el) {
                const node = typeof el === 'string' ? document.querySelector(el) : el
                node.innerHTML = cardForm(false)
                setTimeout(() => handlers.change && handlers.change({ complete: true }), 50)
              },
              destroy() {},
            }
          },
        }
      },
      async createEmbeddedCheckoutPage() {
        return {
          mount(el) { el.innerHTML = checkout() },
          unmount() {},
          destroy() {},
        }
      },
    }
  }
})()
`

const overview = {
  publishableKey: 'pk_test_screenshot',
  card: { id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
  backupCard: null as null | { id: string, brand: string, last4: string, expMonth: number, expYear: number },
  subscription: { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: new Date(Date.now() + 18 * 86400000).toISOString() },
  openInvoice: null as null | { id: string, amountDue: number, currency: string },
  invoices: [0, 1, 2, 3].map(index => ({
    id: `in_${index}`,
    number: `CAPGO-00${42 - index}`,
    created: new Date(Date.now() - (index * 30 + 12) * 86400000).toISOString(),
    total: 9900,
    amountDue: 0,
    currency: 'usd',
    status: 'paid',
    pdfUrl: 'https://example.com/invoice.pdf',
  })),
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

async function setupMocks(page: Page, options: { pastDue?: boolean, backupCard?: boolean } = {}) {
  await page.route('https://js.stripe.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE_STUB }))
  await page.route('**/private/sso/check-enforcement', route => route.fulfill(json({ allowed: true })))
  const openInvoice = options.pastDue ? { id: 'in_open', amountDue: 9900, currency: 'usd' } : null
  await page.route('**/private/stripe_past_due', route => route.fulfill(json(options.pastDue
    ? { past_due: true, invoice: { hosted_invoice_url: null, amount_due: 9900, currency: 'usd', attempt_count: 2, next_payment_attempt: null } }
    : { past_due: false, invoice: null })))
  await page.route('**/private/stripe_billing/overview', route => route.fulfill(json({
    ...overview,
    backupCard: options.backupCard ? { id: 'pm_2', brand: 'mastercard', last4: '5454', expMonth: 9, expYear: 2031 } : null,
    openInvoice,
    subscription: options.pastDue ? { ...overview.subscription, status: 'past_due' } : overview.subscription,
    invoices: options.pastDue
      ? [{ ...overview.invoices[0], id: 'in_open', number: 'CAPGO-0043', created: new Date().toISOString(), amountDue: 9900, status: 'open' }, ...overview.invoices]
      : overview.invoices,
  })))
  await page.route('**/private/stripe_billing/setup-intent', route => route.fulfill(json({ clientSecret: 'seti_1_secret_x', publishableKey: 'pk_test_screenshot' })))
  await page.route('**/private/stripe_billing/invoice-payment-intent', route => route.fulfill(json({ clientSecret: 'pi_1_secret_x', publishableKey: 'pk_test_screenshot' })))
  await page.route('**/private/stripe_billing/pay-invoice', route => route.fulfill(json({ status: 'requires_payment_method', message: 'Your card was declined.' })))
  await page.route('**/private/stripe_checkout', route => route.fulfill(json({ url: null, clientSecret: 'cs_test_1_secret_x', publishableKey: 'pk_test_screenshot', sessionId: 'cs_test_1' })))
}

async function snap(page: Page, name: string, dir = screenshotDir) {
  await page.waitForTimeout(800)
  await page.screenshot({ path: resolve(dir, `${name}.png`), animations: 'disabled' })
}

// Local-only: CAPGO_PR_SCREENSHOTS=1 bunx playwright test playwright/e2e/in-app-billing-screenshots.spec.ts
test.describe('In-app billing screenshots', () => {
  test.skip(!process.env.CAPGO_PR_SCREENSHOTS, 'Set CAPGO_PR_SCREENSHOTS=1 for local PR screenshot capture')

  test.beforeAll(() => {
    mkdirSync(screenshotDir, { recursive: true })
    mkdirSync(backupScreenshotDir, { recursive: true })
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`billing page, card form and cancel flow (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 900 })
      await setupMocks(page)
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/settings/organization/billing')
      await dismissSupportPrompt(page)
      await expect(page.locator('[data-test="billing-invoices"]')).toBeVisible({ timeout: 30000 })
      await snap(page, `billing-page-${scheme}`)

      await page.locator('[data-test="billing-update-card"]').click()
      await expect(page.locator('[data-test="billing-card-submit"]')).toBeEnabled()
      await snap(page, `card-form-${scheme}`)
      await page.locator('[data-test="billing-modal-close"]').click()

      await page.locator('[data-test="billing-cancel"]').click()
      await page.locator('[data-test="cancel-reason-missing_features"]').click()
      await page.locator('[data-test="cancel-comment"]').fill('We need SSO on the Team plan.')
      await snap(page, `cancel-plan-${scheme}`)
    })

    test(`backup card recommendation (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 900 })
      await setupMocks(page)
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/settings/organization/billing')
      await dismissSupportPrompt(page)
      await expect(page.locator('[data-test="billing-backup-card-recommendation"]')).toBeVisible({ timeout: 30000 })
      await snap(page, `recommendation-${scheme}`, backupScreenshotDir)

      await page.locator('[data-test="billing-add-backup-card"]').click()
      await expect(page.locator('[data-test="billing-card-submit"]')).toBeEnabled()
      await snap(page, `backup-card-form-${scheme}`, backupScreenshotDir)
    })

    test(`backup card saved (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 900 })
      await setupMocks(page, { backupCard: true })
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/settings/organization/billing')
      await dismissSupportPrompt(page)
      await expect(page.locator('[data-test="billing-backup-card"]')).toBeVisible({ timeout: 30000 })
      await snap(page, `backup-card-saved-${scheme}`, backupScreenshotDir)
    })

    test(`past due pay flow (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 900 })
      await setupMocks(page, { pastDue: true })
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/settings/organization/billing')
      await dismissSupportPrompt(page)
      await expect(page.locator('[data-test="billing-open-invoice"]')).toBeVisible({ timeout: 30000 })
      await expect(page.locator('[data-test="past-due-banner"]')).toBeVisible()
      await snap(page, `billing-past-due-${scheme}`)

      // Saved card declined: the card form opens in place to pay with a new card.
      await page.locator('[data-test="past-due-pay-now"]').click()
      await expect(page.locator('[data-test="billing-card-submit"]')).toBeEnabled()
      await snap(page, `pay-invoice-${scheme}`)
    })

    test(`embedded upgrade checkout (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1440, height: 900 })
      await setupMocks(page)
      await page.login('test@capgo.app', 'testtest')
      await page.goto('/settings/organization/plans')
      await dismissSupportPrompt(page)
      const upgrade = page.locator('[data-test="plan-action-button"]:not([disabled])').last()
      await expect(upgrade).toBeVisible({ timeout: 30000 })
      await upgrade.click()
      await expect(page.locator('[data-test="embedded-checkout"]')).not.toBeEmpty()
      await snap(page, `upgrade-checkout-${scheme}`)
    })
  }
})
