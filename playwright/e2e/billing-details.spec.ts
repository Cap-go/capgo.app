import { mkdirSync } from 'node:fs'
import type { Page, Route } from '@playwright/test'
import { expect, test } from '../support/commands'
import { dismissSupportPrompt } from '../support/dismissSupportPrompt'

// Render the actual authenticated billing route and exercise its HTTP service wiring.
// Stripe responses are intercepted, following cancel-save-offer.spec.ts; no shared
// organization or real Stripe customer is mutated by these browser tests.
function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

const details = {
  name: 'Example Company', email: 'billing@example.com', phone: '',
  address: { line1: '123 Example Street', line2: '', city: 'Berlin', state: '', postal_code: '10115', country: 'DE' },
}
const currentDiscount = { name: 'Example offer', code: 'EXAMPLE10', percentOff: 10, amountOff: null, currency: null, endsAt: null }

type Call = { path: string, body: Record<string, unknown>, authorization: string | undefined }

async function openBilling(page: Page, options: { discounted?: boolean, rejectUpdate?: boolean, noSubscription?: boolean, rejectCurrency?: boolean, regionalDiscountEligible?: boolean } = {}) {
  if (process.env.CAPGO_PR_SCREENSHOTS)
    await page.setViewportSize({ width: 1440, height: 1100 })
  const calls: Call[] = []
  let profile = { ...structuredClone(details), currency: 'eur', taxIds: [] as { id: string, type: string, value: string, status: string }[] }
  let currencyState = { regionalDiscountEligible: options.regionalDiscountEligible ?? false, currency: 'eur', currencies: ['eur', 'usd'], subscriptionId: options.noSubscription ? null : 'sub_example', endsAt: options.noSubscription ? null : '2030-01-01T00:00:00Z', pendingCurrency: null as string | null }
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

function expectScopedCall(call: Call, orgId: string) {
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/i)
  expect(call.body.orgId).toBe(orgId)
  expect(call.authorization).toMatch(/^Bearer \S+$/)
}

test.describe('Billing details, tax IDs and applied discounts', () => {
  test('saves invoice identity and address through the authenticated page and HTTP API', async ({ page }) => {
    const { calls, getOrgId } = await openBilling(page)
    await expect(page.locator('[data-test="billing-currency"]')).toContainText('EUR')
    await expect(page.locator('[data-test="settings-navigation"] [data-test="settings-switch-section"]')).toHaveCount(1)
    if (process.env.CAPGO_PR_SCREENSHOTS) {
      mkdirSync('docs/pr-screenshots/billing-currency', { recursive: true })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/billing-dark.png' })
    }
    await page.locator('[data-test="billing-edit-details"]').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Billing email', { exact: true })).toHaveValue(details.email)
    await expect(dialog.getByLabel('Phone (optional)', { exact: true })).toHaveAttribute('maxlength', '20')
    await dialog.getByLabel('Full name or company name').fill('Updated Example Company')
    await dialog.getByLabel('Billing email', { exact: true }).fill('invoices@example.com')
    await dialog.getByLabel('Address line 1', { exact: true }).fill('456 Example Avenue')
    await dialog.getByRole('combobox', { name: 'Country', exact: true }).selectOption('FR')
    if (process.env.CAPGO_PR_SCREENSHOTS)
      await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/address-editor.png' })
    await dialog.getByRole('button', { name: 'Save billing details', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-test="billing-profile-details"]')).toContainText('Updated Example Company')
    expect(calls).toHaveLength(1)
    expectScopedCall(calls[0], getOrgId())
    expect(calls[0].body.details).toEqual({
      ...details, name: 'Updated Example Company', email: 'invoices@example.com',
      address: { ...details.address, line1: '456 Example Avenue', country: 'FR' },
    })
    await page.reload()
    await expect(page.locator('[data-test="billing-profile-details"]')).toContainText('invoices@example.com')
    await expect(page.locator('[data-test="billing-profile-details"]')).toContainText('France')
  })

  test('adds a tax ID and requires confirmation before removing it', async ({ page }) => {
    const { calls, getOrgId } = await openBilling(page)
    await page.locator('[data-test="billing-manage-tax"]').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox', { name: 'Tax ID type', exact: true }).selectOption('eu_vat')
    await dialog.getByLabel('VAT / tax number', { exact: true }).fill('DE123456789')
    await dialog.getByRole('button', { name: 'Add tax ID', exact: true }).click()
    await expect(dialog).toContainText('Verification pending')
    expect(calls).toHaveLength(1)
    expectScopedCall(calls[0], getOrgId())
    expect(calls[0].body.taxId).toEqual({ type: 'eu_vat', value: 'DE123456789' })
    await dialog.getByRole('button', { name: 'Remove tax ID', exact: true }).click()
    await expect(dialog).toContainText('Remove this tax ID from future invoices?')
    expect(calls).toHaveLength(1)
    await dialog.getByRole('button', { name: 'Remove tax ID', exact: true }).click()
    await expect(dialog).not.toContainText('DE123456789')
    expect(calls).toHaveLength(2)
    expectScopedCall(calls[1], getOrgId())
    expect(calls[1].body.taxIdId).toBe('txi_example')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await page.reload()
    await expect(page.locator('[data-test="billing-profile"]')).toContainText('No tax ID added')
  })

  test('shows an existing discount inside the subscription card without promo-code entry', async ({ page }) => {
    const { calls } = await openBilling(page, { discounted: true })
    const subscription = page.locator('[data-test="billing-subscription"]')
    await expect(subscription.locator('[data-test="billing-discounts"]')).toContainText('10% off')
    await expect(subscription).toContainText('EXAMPLE10')
    await expect(page.locator('input[name="promotionCode"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Apply code', exact: true })).toHaveCount(0)
    expect(calls).toHaveLength(0)
    await page.reload()
    await expect(subscription).toContainText('EXAMPLE10')
  })

  test('omits discount UI when the subscription has no discount', async ({ page }) => {
    await openBilling(page)
    await expect(page.locator('[data-test="billing-discounts"]')).toHaveCount(0)
    await expect(page.locator('input[name="promotionCode"]')).toHaveCount(0)
  })

  test('does not offer promo-code entry without a subscription', async ({ page }) => {
    await openBilling(page, { noSubscription: true })
    await expect(page.locator('[data-test="billing-subscription"]')).toContainText('No active subscription')
    await expect(page.locator('[data-test="billing-discounts"]')).toHaveCount(0)
    await expect(page.locator('input[name="promotionCode"]')).toHaveCount(0)
  })

  test('retains saved details when the API rejects changes', async ({ page }) => {
    const { calls } = await openBilling(page, { rejectUpdate: true })
    await page.locator('[data-test="billing-edit-details"]').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Full name or company name').fill('Unsaved Company')
    await dialog.getByRole('button', { name: 'Save billing details', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Could not save billing details')
    await expect(dialog.getByLabel('Full name or company name')).toHaveValue('Unsaved Company')
    await dialog.locator('[data-test="billing-details-form"]').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('[data-test="billing-profile-details"]')).toContainText('Example Company')
    expect(calls).toHaveLength(1)
  })
})


test('credits display the billing currency and block purchases when pricing is unavailable', async ({ page }) => {
  await openBilling(page)
  let unavailable = false
  await page.route('**/private/credits/quote', route => route.fulfill(unavailable ? json({ error: 'credit_currency_unavailable' }, 400) : json({ currency: 'eur', unitAmount: 92, unitPrice: 0.92 })))
  await page.route('**/private/credits/auto-top-up', route => route.fulfill(json({ enabled: false, threshold: 10, monthlyLimit: 0, monthlyTotal: 0, hasPaymentMethod: true })))
  await page.goto('/settings/organization/credits')
  await expect(page.getByText('Billed in EUR', { exact: false })).toBeVisible()
  await expect(page.getByText('Subtotal: €92.00.', { exact: false })).toBeVisible()
  await expect(page.locator('[data-test="credits-top-up-submit"]')).toBeEnabled()
  if (process.env.CAPGO_PR_SCREENSHOTS) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/credits-eur.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/credits-mobile.png' })
  }
  unavailable = true
  await page.reload()
  await expect(page.getByText('Could not load prices in your billing currency.', { exact: false })).toBeVisible()
  await expect(page.locator('[data-test="credits-top-up-submit"]')).toBeDisabled()
})


test('offers USD after the yearly currency limit and requires reviewing prices before retrying', async ({ page }) => {
  await openBilling(page)
  const products = ['prod_LQIregjtNduh4q', 'prod_LQIs1Yucml9ChU', 'prod_LQIugvJcPrxhda', 'prod_MH5Jh6ajC9e7ZH', 'prod_VDt1FTF7XJxyMR', 'prod_VDt2cnktX7IDVV', 'prod_VDt2xM7OyLzhqV', 'prod_VDt2pia049SqpU']
  const prices = Object.fromEntries(products.map(id => [id, { month: { usd: 3900, ars: 20000000 }, year: { usd: 39600, ars: 120000000 } }]))
  await page.route('**/private/plan_prices**', route => route.fulfill(json({ complete: true, currencies: ['ars', 'usd'], currency: 'ars', lockedCurrency: null, prices, regularPrices: prices, discount: { percent: 30, country: 'AR', currencies: ['ars'] } })))
  const checkouts: Record<string, unknown>[] = []
  await page.route('**/private/stripe_checkout', (route) => {
    checkouts.push(route.request().postDataJSON())
    return route.fulfill(json({ error: 'checkout_amount_limit', moreInfo: { currency: 'ars', canSwitchToUsd: true } }, 400))
  })
  await page.goto('/settings/organization/plans')
  await page.locator('[data-test="plans-currency-select"]').selectOption('ars')
  await page.getByRole('button', { name: /Yearly/ }).click()
  const maker = page.locator('[data-test="plan-card"]').filter({ has: page.getByRole('heading', { name: 'Maker', exact: true }) })
  await maker.locator('[data-test="plan-action-button"]').click()
  const alert = page.locator('[data-test="checkout-amount-limit"]')
  await expect(alert).toContainText('Switch to USD')
  if (process.env.CAPGO_PR_SCREENSHOTS) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/checkout-limit.png' })
  }
  await alert.getByRole('button', { name: 'Show prices in USD' }).click()
  await expect(page.locator('[data-test="plans-currency-select"]')).toHaveValue('usd')
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0].currency).toBe('ars')
  expect(checkouts[0].recurrence).toBe('year')
  await maker.locator('[data-test="plan-action-button"]').click()
  await expect.poll(() => checkouts.length).toBe(2)
  expect(checkouts[1].currency).toBe('usd')
  expect(checkouts[1].standardPrice).toBe(true)
})


test('changes currency immediately without a subscription', async ({ page }) => {
  const { calls, getOrgId } = await openBilling(page, { noSubscription: true })
  await page.getByRole('button', { name: 'Change currency', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('usd')
  await expect(dialog).toContainText('No payment is taken now')
  await expect(dialog.getByRole('button', { name: 'Save currency' })).toBeEnabled()
  if (process.env.CAPGO_PR_SCREENSHOTS)
    await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/change-currency.png' })
  await dialog.getByRole('button', { name: 'Save currency' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('[data-test="billing-currency"]')).toContainText('USD')
  const call = calls.find(call => call.path === 'currency/update')!
  expectScopedCall(call, getOrgId())
  expect(call.body).toMatchObject({ currency: 'usd', confirmedSubscription: null })
  await expect(page.locator('[data-test="billing-currency"]').getByRole('link', { name: 'Choose a plan', exact: true })).toHaveAttribute('href', '/settings/organization/plans')
})

test('confirms the automatic currency replacement and renewal price', async ({ page }) => {
  const { calls } = await openBilling(page)
  await page.getByRole('button', { name: 'Change currency', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('usd')
  const submit = dialog.getByRole('button', { name: 'Confirm automatic currency change' })
  await expect(submit).toBeDisabled()
  await expect(dialog).toContainText('You do not need to restart it yourself')
  await expect(dialog.locator('[data-test="billing-currency-renewal"]')).toContainText('$14.00')
  await expect(dialog.locator('[data-test="billing-currency-regional-note"]')).toHaveCount(0)
  await dialog.getByRole('checkbox').check()
  await expect(submit).toBeEnabled()
  if (process.env.CAPGO_PR_SCREENSHOTS)
    await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/change-subscription-currency.png' })
  await submit.click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('[data-test="billing-currency-pending"]')).toContainText('USD')
  await expect(page.locator('[data-test="billing-currency"]')).toContainText('EUR')
  expect(calls.find(call => call.path === 'currency/update')?.body).toMatchObject({ currency: 'usd', confirmedSubscription: 'sub_example', quoteId: 'quote_example' })
  await expect(page.locator('[data-test="billing-subscription"]')).toContainText('Automatically renews in USD')
  await expect(page.locator('[data-test="billing-currency-pending"]')).toContainText('No restart is needed')
  if (process.env.CAPGO_PR_SCREENSHOTS)
    await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/pending-currency.png' })
})

test('retains the current currency and offers a retry after a failed change', async ({ page }) => {
  await openBilling(page, { noSubscription: true, rejectCurrency: true })
  await page.getByRole('button', { name: 'Change currency', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption('usd')
  await dialog.getByRole('button', { name: 'Save currency' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Could not change currency')
  await expect(dialog.getByRole('button', { name: 'Save currency' })).toBeEnabled()
  await expect(page.locator('[data-test="billing-currency"] > p').first()).toHaveText('EUR')
})

for (const scenario of ['trial', 'Solo']) {
  test(`currency editor explains the matching card country requirement for ${scenario}`, async ({ page }) => {
    await openBilling(page, { noSubscription: scenario === 'trial', regionalDiscountEligible: true })
    await page.getByRole('button', { name: 'Change currency', exact: true }).click()
    const note = page.getByRole('dialog').locator('[data-test="billing-currency-regional-note"]')
    await expect(note).toContainText('credit card issued in the same eligible country as your billing address')
    if (process.env.CAPGO_PR_SCREENSHOTS && scenario === 'trial')
      await page.screenshot({ animations: 'disabled', path: 'docs/pr-screenshots/billing-currency/currency-trial-discount.png' })
  })
}
