import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// The cancel dialog's save offer, with the billing API mocked: Stripe is not involved.
const OFFER_ID = '00000000-0000-4000-8000-000000000001'
const CREDITS_OFFER_ID = '00000000-0000-4000-8000-000000000002'
const activeSubscription = { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: new Date(Date.now() + 18 * 86400000).toISOString() }

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function body(route: Route) {
  return route.request().postDataJSON() as Record<string, unknown>
}

async function openCancelDialog(page: Page, offer: (route: Route) => Promise<void>, reason = 'too_expensive', comment = '') {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  let offerAccepted = false
  await page.route('**/private/config', route => route.fulfill(json({ stripeEnabled: true })))
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
  await page.route('**/private/stripe_billing/profile', route => route.fulfill(json({
    name: '', email: '', phone: '', taxIds: [],
    address: { line1: '', line2: '', city: '', state: '', postal_code: '', country: '' },
  })))
  await page.route('**/private/stripe_billing/cancel-offer', async (route) => {
    calls.push({ path: 'cancel-offer', body: body(route) })
    await offer(route)
  })
  await page.route('**/private/stripe_billing/cancel-offer/accept', async (route) => {
    calls.push({ path: 'accept', body: body(route) })
    const credits = body(route).offerId === CREDITS_OFFER_ID
    // Only the discount shows up as a discount on the subscription.
    offerAccepted = !credits
    await route.fulfill(json(credits
      ? { type: 'credits', credits: 29, subscription: { ...activeSubscription, cancelAtPeriodEnd: true } }
      : { type: 'discount', discountEnd: new Date(Date.now() + 90 * 86400000).toISOString(), subscription: activeSubscription }))
  })
  await page.route('**/private/stripe_billing/discounts', route => route.fulfill(json({
    discounts: offerAccepted
      ? [{ name: 'Example retention offer', code: null, percentOff: 50, amountOff: null, currency: null, endsAt: null }]
      : [],
  })))
  await page.route('**/private/stripe_billing/cancel', async (route) => {
    calls.push({ path: 'cancel', body: body(route) })
    await route.fulfill(json({ subscription: { ...activeSubscription, cancelAtPeriodEnd: true } }))
  })

  await page.login('test@capgo.app', 'testtest')
  const discountsLoaded = page.waitForResponse('**/private/stripe_billing/discounts')
  await page.goto('/settings/organization/billing')
  await discountsLoaded
  await dismissSupportPrompt(page)
  await page.locator('[data-test="billing-cancel"]').click({ timeout: 30000 })
  await page.locator(`[data-test="cancel-reason-${reason}"]`).click()
  if (comment)
    await page.locator('[data-test="cancel-comment"]').fill(comment)
  await page.locator('[data-test="cancel-plan-confirm"]').click()
  return calls
}

async function continuePastLoss(page: Page) {
  await expect(page.locator('[data-test="cancel-loss-reminder"]')).toBeVisible()
  await page.locator('[data-test="cancel-loss-continue"]').click()
}

const eligible = (route: Route) => route.fulfill(json({ offer: { id: OFFER_ID, type: 'discount', percentOff: 50, durationMonths: 3, monthlyAmount: 2900, discountedAmount: 1450, currency: 'usd' } }))

test.describe('Cancel plan save offer', () => {
  test('keeping the plan with the discount does not cancel it', async ({ page }) => {
    const calls = await openCancelDialog(page, eligible)
    const discounts = page.locator('[data-test="billing-subscription"] [data-test="billing-discounts"]')
    await expect(discounts).toHaveCount(0)
    await continuePastLoss(page)
    await expect(page.locator('[data-test="cancel-save-offer"]')).toBeVisible()
    await page.locator('[data-test="cancel-offer-accept"]').click()
    await expect(page.locator('[data-test="cancel-save-offer"]')).toBeHidden()
    await expect(discounts).toContainText('50% off')
    await expect(discounts).toContainText('Example retention offer')
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'accept'])
    expect(calls[0].body).toMatchObject({ reason: 'too_expensive' })
    expect(calls[1].body).toMatchObject({ offerId: OFFER_ID })
  })

  test('a customer who barely uses the plan can switch to credits', async ({ page }) => {
    const credits = (route: Route) => route.fulfill(json({ offer: { id: CREDITS_OFFER_ID, type: 'credits', credits: 29, monthlyAmount: 2900, currency: 'usd' } }))
    const calls = await openCancelDialog(page, credits, 'unused', 'only one app left')
    await continuePastLoss(page)
    const offer = page.locator('[data-test="cancel-save-offer"]')
    await expect(offer).toHaveAttribute('data-offer-type', 'credits')
    await expect(offer).toContainText('Switch to credits instead of canceling')
    const accept = page.locator('[data-test="cancel-offer-accept"]')
    await expect(accept).toHaveText('Switch and get 29 credits')
    await accept.click()
    await expect(offer).toBeHidden()
    // The plan now ends at period end, and no discount was applied.
    await expect(page.locator('[data-test="billing-subscription"] [data-test="billing-discounts"]')).toHaveCount(0)
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'accept'])
    expect(calls[0].body).toMatchObject({ reason: 'unused' })
    expect(calls[1].body).toMatchObject({ offerId: CREDITS_OFFER_ID, comment: 'only one app left' })
  })

  test('declining the offer cancels and records the offer', async ({ page }) => {
    const calls = await openCancelDialog(page, eligible)
    await continuePastLoss(page)
    await page.locator('[data-test="cancel-offer-decline"]').click()
    await expect(page.locator('[data-test="cancel-save-offer"]')).toBeHidden()
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'cancel'])
    expect(calls[1].body).toMatchObject({ reason: 'too_expensive', offerId: OFFER_ID })
  })

  test('cancels directly when the offer cannot load', async ({ page }) => {
    const calls = await openCancelDialog(page, route => route.fulfill(json({ error: 'internal_error' }, 500)))
    await continuePastLoss(page)
    await expect(page.locator('[data-test="cancel-loss-reminder"]')).toBeHidden()
    await expect(page.locator('[data-test="cancel-plan-form"]')).toBeHidden()
    expect(calls.map(call => call.path)).toEqual(['cancel-offer', 'cancel'])
    expect(calls[1].body.offerId).toBeUndefined()
  })

  test('keep plan on the loss step closes the dialog without calling Stripe', async ({ page }) => {
    const calls = await openCancelDialog(page, eligible)
    await expect(page.locator('[data-test="cancel-loss-reminder"]')).toBeVisible()
    await page.locator('[data-test="cancel-loss-keep-plan"]').click()
    await expect(page.locator('[data-test="cancel-loss-reminder"]')).toBeHidden()
    expect(calls).toEqual([])
  })
})
