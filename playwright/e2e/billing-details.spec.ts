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

async function openBilling(page: Page, options: { discounted?: boolean, rejectUpdate?: boolean, noSubscription?: boolean } = {}) {
  const calls: Call[] = []
  let profile = { ...structuredClone(details), taxIds: [] as { id: string, type: string, value: string, status: string }[] }
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
      subscription: options.noSubscription ? null : { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: '2030-01-01T00:00:00Z' },
    }))
  })
  await page.route('**/private/stripe_billing/invoice-email', route => route.fulfill(json(emailPreferences)))
  await page.route('**/private/stripe_billing/invoice-email/update', (route) => {
    const body = capture(route, 'invoice-email/update')
    emailPreferences = { ...emailPreferences, ...body.preferences as { enabled: boolean, recipients: string[] } }
    return route.fulfill(json(emailPreferences))
  })
  await page.route('**/private/stripe_billing/profile', route => route.fulfill(json(profile)))
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
    await page.locator('[data-test="billing-edit-details"]').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Billing email', { exact: true })).toHaveValue(details.email)
    await expect(dialog.getByLabel('Phone (optional)', { exact: true })).toHaveAttribute('maxlength', '20')
    await dialog.getByLabel('Full name or company name').fill('Updated Example Company')
    await dialog.getByLabel('Billing email', { exact: true }).fill('invoices@example.com')
    await dialog.getByLabel('Address line 1', { exact: true }).fill('456 Example Avenue')
    await dialog.getByRole('combobox', { name: 'Country', exact: true }).selectOption('FR')
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
    await expect(dialog).toContainText('Remove this tax ID from your billing profile?')
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
