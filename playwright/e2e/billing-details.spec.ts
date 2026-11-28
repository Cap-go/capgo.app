import { mkdirSync } from 'node:fs'
import { expect, test } from '../support/commands'
import { details, expectScopedCall, openBilling } from '../support/billingPage'

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
