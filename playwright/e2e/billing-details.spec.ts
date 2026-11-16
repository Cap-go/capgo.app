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

async function openBilling(page: Page, options: { discounted?: boolean, rejectUpdate?: boolean, rejectPromotion?: boolean, changedPromotion?: boolean } = {}) {
  const calls: Call[] = []
  let profile = { ...structuredClone(details), taxIds: [] as { id: string, type: string, value: string, status: string }[] }
  let discounts = options.discounted ? [currentDiscount] : []
  let orgId = ''
  let changedPromotion = options.changedPromotion
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
      subscription: { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: '2030-01-01T00:00:00Z' },
    }))
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
  await page.route('**/private/stripe_billing/discounts', route => route.fulfill(json({ hasSubscription: true, canApply: true, discounts })))
  await page.route('**/private/stripe_billing/promotion-code', (route) => {
    const body = capture(route, 'promotion-code')
    if (options.rejectPromotion)
      return route.fulfill(json({ error: 'invalid_promotion_code' }, 400))
    if (changedPromotion) {
      changedPromotion = false
      return route.fulfill(json({ discounts }))
    }
    discounts = [{ ...currentDiscount, code: String(body.code), percentOff: 20 }]
    return route.fulfill(json({ discounts }))
  })
  await page.login('test@capgo.app', 'testtest')
  await page.goto('/settings/organization/billing')
  await dismissSupportPrompt(page)
  await expect(page.locator('[data-test="billing-profile-details"]')).toContainText(details.email)
  await expect(page.locator('[data-test="billing-discounts"]')).toContainText('Discount / promo code')
  return { calls, getOrgId: () => orgId }
}

function expectScopedCall(call: Call, orgId: string) {
  expect(orgId).toMatch(/^[0-9a-f-]{36}$/i)
  expect(call.body.orgId).toBe(orgId)
  expect(call.authorization).toMatch(/^Bearer \S+$/)
}

test.describe('Billing details, tax IDs and promotion codes', () => {
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

  test('redeems a promotion code only after confirming replacement of the current discount', async ({ page }) => {
    const { calls, getOrgId } = await openBilling(page, { discounted: true })
    const section = page.locator('[data-test="billing-discounts"]')
    await expect(section).toContainText('10% off')
    await section.getByLabel('Discount / promo code', { exact: true }).fill('EXAMPLE20')
    const apply = section.getByRole('button', { name: 'Apply code', exact: true })
    await expect(apply).toBeDisabled()
    expect(calls).toHaveLength(0)
    await section.getByRole('checkbox').check()
    await apply.click()
    await expect(section).toContainText('Promo code applied to future subscription invoices.')
    await expect(section).toContainText('20% off')
    expect(calls).toHaveLength(1)
    expectScopedCall(calls[0], getOrgId())
    expect(calls[0].body).toMatchObject({ code: 'EXAMPLE20', replaceExisting: true })
    expect(calls[0].body.redemptionId).toMatch(/^[0-9a-f-]{36}$/i)
    await page.reload()
    await expect(section).toContainText('20% off')
    await expect(section).toContainText('EXAMPLE20')
  })

  test('requires fresh confirmation when a concurrent change supersedes a promo-code redemption', async ({ page }) => {
    const { calls } = await openBilling(page, { discounted: true, changedPromotion: true })
    const section = page.locator('[data-test="billing-discounts"]')
    await section.getByLabel('Discount / promo code', { exact: true }).fill('EXAMPLE20')
    await section.getByRole('checkbox').check()
    const apply = section.getByRole('button', { name: 'Apply code', exact: true })
    await apply.click()
    await expect(section.getByRole('alert')).toContainText('The subscription discount changed')
    await expect(section).toContainText('10% off')
    await expect(section).not.toContainText('Promo code applied to future subscription invoices.')
    await expect(apply).toBeDisabled()
    await section.getByRole('checkbox').check()
    await apply.click()
    await expect(section).toContainText('20% off')
    await expect(section).toContainText('Promo code applied to future subscription invoices.')
    expect(calls).toHaveLength(2)
    expect(calls[1].body.redemptionId).not.toBe(calls[0].body.redemptionId)
    expect(calls[1].body.replaceExisting).toBe(true)
  })

  test('retains saved details and discounts when the API rejects changes', async ({ page }) => {
    const { calls } = await openBilling(page, { discounted: true, rejectUpdate: true, rejectPromotion: true })
    await page.locator('[data-test="billing-edit-details"]').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Full name or company name').fill('Unsaved Company')
    await dialog.getByRole('button', { name: 'Save billing details', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Could not save billing details')
    await expect(dialog.getByLabel('Full name or company name')).toHaveValue('Unsaved Company')
    await dialog.locator('[data-test="billing-details-form"]').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('[data-test="billing-profile-details"]')).toContainText('Example Company')
    const section = page.locator('[data-test="billing-discounts"]')
    await section.getByLabel('Discount / promo code', { exact: true }).fill('INVALID')
    await section.getByRole('checkbox').check()
    await section.getByRole('button', { name: 'Apply code', exact: true }).click()
    await expect(section.getByRole('alert')).toContainText('Could not apply this code')
    await expect(section).toContainText('10% off')
    expect(calls.map(call => call.path)).toEqual(['profile/update', 'promotion-code'])
  })
})
