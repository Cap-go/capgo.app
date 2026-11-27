import { expect, test } from '../support/commands'
import { expectScopedCall, json, openBilling } from '../support/billingPage'

test('saves five invoice mailboxes and persists an opt-out after reload', async ({ page }) => {
  const { calls, getOrgId } = await openBilling(page)
  const section = page.locator('[data-test="invoice-emails"]')
  const toggle = section.getByRole('checkbox')
  await expect(toggle).toBeChecked()
  const recipients = Array.from({ length: 5 }, (_, i) => `account${i}@example.com`)
  await section.getByRole('textbox').fill(recipients.join('\n'))
  await section.getByRole('button', { name: 'Save invoice emails' }).click()
  await expect(section.getByRole('status')).toContainText('saved')
  const call = calls.find(call => call.path === 'invoice-email/update')!
  expectScopedCall(call, getOrgId())
  expect(call.body.preferences).toEqual({ enabled: true, recipients })
  await toggle.uncheck()
  await section.getByRole('button', { name: 'Save invoice emails' }).click()
  await expect(section.getByRole('status')).toContainText('saved')
  await page.reload()
  await expect(page.locator('[data-test="invoice-emails"]').getByRole('checkbox')).not.toBeChecked()
  await expect(page.locator('[data-test="invoice-emails"]').getByRole('textbox')).toHaveValue(recipients.join('\n'))
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


test('can disable automatic top-up even when the credit quote is unavailable', async ({ page }) => {
  await openBilling(page)
  await page.route('**/private/credits/quote', route => route.fulfill(json({ error: 'credit_currency_unavailable' }, 400)))
  let saved: unknown
  await page.route('**/private/credits/auto-top-up*', route => {
    if (route.request().method() === 'GET')
      return route.fulfill(json({ enabled: true, threshold: 10, monthlyLimit: 100, monthlyTotal: 0, hasPaymentMethod: true }))
    saved = route.request().postDataJSON()
    return route.fulfill(json({ enabled: false, threshold: 10, monthlyLimit: 100, monthlyTotal: 0, hasPaymentMethod: true }))
  })
  await page.goto('/settings/organization/credits')
  const toggle = page.locator('input.d-toggle')
  await expect(toggle).toBeChecked()
  await expect(toggle).toBeEnabled()
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => saved).toMatchObject({ enabled: false, threshold: 10, monthlyLimit: 100 })
  await expect(page.locator('[data-test="credits-top-up-submit"]')).toBeDisabled()
})
