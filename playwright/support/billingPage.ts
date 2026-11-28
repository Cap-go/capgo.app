// Shared by billing-details.spec.ts and billing-currency.spec.ts, split so the two run on
// different Playwright shards.
import type { Page, Route } from '@playwright/test'
import { expect } from './commands'
import { dismissSupportPrompt } from './dismissSupportPrompt'

// Render the actual authenticated billing route and exercise its HTTP service wiring.
// Stripe responses are intercepted, following cancel-save-offer.spec.ts; no shared
// organization or real Stripe customer is mutated by these browser tests.
export function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

export const details = {
  name: 'Example Company', email: 'billing@example.com', phone: '',
  address: { line1: '123 Example Street', line2: '', city: 'Berlin', state: '', postal_code: '10115', country: 'DE' },
}
const currentDiscount = { name: 'Example offer', code: 'EXAMPLE10', percentOff: 10, amountOff: null, currency: null, endsAt: null }

type Call = { path: string, body: Record<string, unknown>, authorization: string | undefined }

export async function openBilling(page: Page, options: { discounted?: boolean, rejectUpdate?: boolean, noSubscription?: boolean, rejectCurrency?: boolean, regionalDiscountEligible?: boolean } = {}) {
  if (process.env.CAPGO_PR_SCREENSHOTS)
    await page.setViewportSize({ width: 1440, height: 1100 })
  const calls: Call[] = []
  let profile = { ...structuredClone(details), currency: 'eur', taxIds: [] as { id: string, type: string, value: string, status: string }[] }
  let currencyState = { regionalDiscountEligible: options.regionalDiscountEligible ?? false, currency: 'eur', currencies: ['eur', 'usd'], subscriptionId: options.noSubscription ? null : 'sub_example', endsAt: options.noSubscription ? null : '2030-01-01T00:00:00Z', pendingCurrency: null as string | null }
  let emailPreferences = { enabled: true, recipients: [] as string[], defaultEmail: details.email }
  const discounts = options.discounted ? [currentDiscount] : []
  let orgId = ''
  function capture(route: Route, path: string) {
    const request = route.request()
    const body = request.postDataJSON() as Record<string, unknown>
    calls.push({ path, body, authorization: request.headers().authorization })
    return body
  }
  await page.route('**/private/config', route => route.fulfill(json({ stripeEnabled: true })))
  await page.route('**/private/sso/check-enforcement', route => route.fulfill(json({ allowed: true })))
  await page.route('**/private/stripe_past_due', route => route.fulfill(json({ past_due: false, invoice: null })))
  await page.route('**/private/stripe_billing/overview', (route) => {
    orgId = route.request().postDataJSON().orgId
    return route.fulfill(json({
      publishableKey: '', card: null, backupCard: null, invoices: [], openInvoice: null, trialPlan: null,
      subscription: options.noSubscription ? null : { pendingCurrency: currencyState.pendingCurrency, status: 'active', cancelAtPeriodEnd: !!currencyState.pendingCurrency, cancelAt: null, currentPeriodEnd: '2030-01-01T00:00:00Z' },
    }))
  })
  await page.route('**/private/stripe_billing/invoice-email', route => route.fulfill(json(emailPreferences)))
  await page.route('**/private/stripe_billing/invoice-email/update', (route) => {
    const body = capture(route, 'invoice-email/update')
    emailPreferences = { ...emailPreferences, ...body.preferences as { enabled: boolean, recipients: string[] } }
    return route.fulfill(json(emailPreferences))
  })
  await page.route('**/private/stripe_billing/profile', route => route.fulfill(json(profile)))
  await page.route('**/private/stripe_billing/currency', route => route.fulfill(json(currencyState)))
  await page.route('**/private/stripe_billing/currency/preview', route => route.fulfill(json({ currency: route.request().postDataJSON().currency, amount: 1400, interval: 'month', subscriptionId: 'sub_example', quoteId: 'quote_example' })))
  await page.route('**/private/stripe_billing/currency/update', (route) => {
    const body = capture(route, 'currency/update')
    if (options.rejectCurrency)
      return route.fulfill(json({ error: 'billing_currency_failed' }, 400))
    currencyState = { ...currencyState, ...(currencyState.subscriptionId ? { pendingCurrency: body.currency as string } : { currency: body.currency as string }) }
    return route.fulfill(json(currencyState))
  })

  await page.route('**/private/stripe_billing/profile/update', (route) => {
    const body = capture(route, 'profile/update')
    if (options.rejectUpdate)
      return route.fulfill(json({ error: 'invalid_billing_details' }, 400))
    profile = { ...profile, ...body.details as typeof details }
    return route.fulfill(json(body.details))
  })
  await page.route('**/private/stripe_billing/tax-id/add', (route) => {
    const body = capture(route, 'tax-id/add')
    const taxId = { ...body.taxId as { type: string, value: string }, id: 'txi_example', status: 'pending' }
    profile.taxIds.push(taxId)
    return route.fulfill(json(taxId))
  })
  await page.route('**/private/stripe_billing/tax-id/remove', (route) => {
    const body = capture(route, 'tax-id/remove')
    profile.taxIds = profile.taxIds.filter(tax => tax.id !== body.taxIdId)
    return route.fulfill(json({ status: 'ok' }))
  })
  await page.route('**/private/stripe_billing/discounts', route => route.fulfill(json({ discounts })))
  await page.login('test@capgo.app', 'testtest')
  await page.goto('/settings/organization/billing')
  await dismissSupportPrompt(page)
  await expect(page.locator('[data-test="billing-profile-details"]')).toContainText(details.email)
  await expect(page.locator('[data-test="billing-subscription"]')).toBeVisible()
  return { calls, getOrgId: () => orgId }
}

export function expectScopedCall(call: Call, orgId: string) {
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/i)
  expect(call.body.orgId).toBe(orgId)
  expect(call.authorization).toMatch(/^Bearer \S+$/)
}
