import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// The cancel dialog's save offer, with the billing API mocked: Stripe is not involved.
const OFFER_ID = '00000000-0000-4000-8000-000000000001'
const activeSubscription = { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: new Date(Date.now() + 18 * 86400000).toISOString() }

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function body(route: Route) {
  return route.request().postDataJSON() as Record<string, unknown>
}

async function openCancelDialog(page: Page, offer: (route: Route) => Promise<void>) {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  await page.route('**/private/sso/check-enforcement', route => route.fulfill(json({ allowed: true })))
  await page.route('**/private/stripe_past_due', route => route.fulfill(json({ past_due: false, invoice: null })))
  await page.route('**/private/stripe_billing/overview', route => route.fulfill(json({
    publishableKey: '',
    card: { id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
    backupCard: null,
    subscription: activeSubscription,
    invoices: [],
    openInvoice: null,
    trialPlan: null,
  })))
  await page.route('**/private/stripe_billing/cancel-offer', async (route) => {
    calls.push({ path: 'cancel-offer', body: body(route) })
    await offer(route)
  })
  await page.route('**/private/stripe_billing/cancel-offer/accept', async (route) => {
    calls.push({ path: 'accept', body: body(route) })
    await route.fulfill(json({ discountEnd: new Date(Date.now() + 90 * 86400000).toISOString(), subscription: activeSubscription }))
  })
  await page.route('**/private/stripe_billing/cancel', async (route) => {
    calls.push({ path: 'cancel', body: body(route) })
    await route.fulfill(json({ subscription: { ...activeSubscription, cancelAtPeriodEnd: true } }))
  })

  await page.login('test@capgo.app', 'testtest')
  await page.goto('/settings/organization/billing')
  await dismissSupportPrompt(page)
  await page.locator('[data-test="billing-cancel"]').click({ timeout: 30000 })
  await page.locator('[data-test="cancel-reason-too_expensive"]').click()
  await page.locator('[data-test="cancel-plan-confirm"]').click()
  return calls
}

const eligible = (route: Route) => route.fulfill(json({ offer: { id: OFFER_ID, percentOff: 50, durationMonths: 3, monthlyAmount: 2900, discountedAmount: 1450, currency: 'usd' } }))

test.describe('Cancel plan save offer', () => {
  test('keeping the plan with the discount does not cancel it', async ({ page }) => {
    const calls = await openCancelDialog(page, eligible)
    await expect(page.locator('[data-test="cancel-save-offer"]')).toBeVisible()
    await page.locator('[data-test="cancel-offer-accept"]').click()
    await expect(page.locator('[data-test="cancel-save-offer"]')).toBeHidden()
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'accept'])
    expect(calls[0].body).toMatchObject({ reason: 'too_expensive' })
    expect(calls[1].body).toMatchObject({ offerId: OFFER_ID })
  })

  test('declining the offer cancels and records the offer', async ({ page }) => {
    const calls = await openCancelDialog(page, eligible)
    await page.locator('[data-test="cancel-offer-decline"]').click()
    await expect(page.locator('[data-test="cancel-save-offer"]')).toBeHidden()
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'cancel'])
    expect(calls[1].body).toMatchObject({ reason: 'too_expensive', offerId: OFFER_ID })
  })

  test('cancels directly when the offer cannot load', async ({ page }) => {
    const calls = await openCancelDialog(page, route => route.fulfill(json({ error: 'internal_error' }, 500)))
    await expect(page.locator('[data-test="cancel-plan-form"]')).toBeHidden()
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'cancel'])
    expect(calls[1].body.offerId).toBeUndefined()
  })
})
