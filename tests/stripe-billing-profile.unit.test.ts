import type { InAppBillingContext } from '../supabase/functions/_backend/utils/stripe_in_app'
import { describe, expect, it, vi } from 'vitest'
import { addBillingTaxId, getBillingProfile, parseBillingDetails, removeBillingTaxId, updateBillingDetails } from '../supabase/functions/_backend/utils/stripe_billing_profile'

const details = {
  name: 'Example Company', email: 'billing@example.com', phone: '',
  address: { line1: '123 Example Street', line2: '', city: 'Berlin', state: '', postal_code: '10115', country: 'DE' },
}
function context() {
  const customers = { retrieve: vi.fn(), update: vi.fn(), listTaxIds: vi.fn(), createTaxId: vi.fn(), deleteTaxId: vi.fn() }
  const ctx = { customerId: 'cus_example', billingAccount: 'us', stripe: { customers }, publishableKey: '' } as unknown as InAppBillingContext
  return { ctx, customers }
}

describe('billing profile', () => {
  it.concurrent('returns only invoice fields and tax verification, without private Stripe metadata', async () => {
    const { ctx, customers } = context()
    customers.retrieve.mockResolvedValue({ ...details, metadata: { private: 'hidden' } })
    customers.listTaxIds.mockResolvedValue({ data: [{ id: 'txi_example', type: 'eu_vat', value: 'DE123456789', verification: { status: 'pending' } }] })
    expect(await getBillingProfile(ctx)).toEqual({ ...details, currency: null, taxIds: [{ id: 'txi_example', type: 'eu_vat', value: 'DE123456789', status: 'pending' }] })
    expect(customers.retrieve).toHaveBeenCalledWith('cus_example')
    expect(customers.listTaxIds).toHaveBeenCalledWith('cus_example', { limit: 100 })
  })
  it.concurrent('normalizes missing fields without inventing billing data', async () => {
    const { ctx, customers } = context()
    customers.retrieve.mockResolvedValue({ address: null })
    customers.listTaxIds.mockResolvedValue({ data: [] })
    expect(await getBillingProfile(ctx)).toMatchObject({ name: '', email: '', address: { country: '', line1: '' }, taxIds: [] })
  })
  it.concurrent('writes only validated details to the resolved account and customer', async () => {
    const { ctx, customers } = context()
    customers.update.mockResolvedValue(details)
    expect(await updateBillingDetails(ctx, { ...details, name: ' Example Company ' })).toEqual(details)
    expect(customers.update).toHaveBeenCalledWith('cus_example', details)
  })
  it.concurrent('accepts a phone at the Stripe limit and rejects longer values before saving', async () => {
    const { ctx, customers } = context()
    const valid = { ...details, phone: '+'.padEnd(20, '1') }
    customers.update.mockResolvedValue(valid)
    await expect(updateBillingDetails(ctx, valid)).resolves.toEqual(valid)
    await expect(updateBillingDetails(ctx, { ...valid, phone: `${valid.phone}1` })).rejects.toMatchObject({ cause: { error: 'invalid_billing_details' } })
    expect(customers.update).toHaveBeenCalledTimes(1)
  })
  it.concurrent.each([
    { ...details, email: 'invalid' }, { ...details, name: '' },
    { ...details, address: { ...details.address, country: 'ZZ' } },
    { ...details, balance: -10000 }, { ...details, tax_exempt: 'exempt' },
    { ...details, customerId: 'cus_other' }, { ...details, name: 'x'.repeat(201) },
    null,
  ])('rejects invalid or privileged fields: %j', (input) => {
    expect(() => parseBillingDetails(input)).toThrow()
  })
  it.concurrent('adds tax IDs without changing tax exemption and lets Stripe verify them', async () => {
    const { ctx, customers } = context()
    customers.createTaxId.mockResolvedValue({ id: 'txi_example', type: 'eu_vat', value: 'DE123456789', verification: { status: 'pending' } })
    expect(await addBillingTaxId(ctx, { type: 'eu_vat', value: ' DE123456789 ' })).toMatchObject({ status: 'pending' })
    expect(customers.createTaxId).toHaveBeenCalledWith('cus_example', { type: 'eu_vat', value: 'DE123456789' })
    expect(customers.update).not.toHaveBeenCalled()
  })
  it.concurrent('does not remove old tax IDs when Stripe rejects a new one', async () => {
    const { ctx, customers } = context()
    customers.createTaxId.mockRejectedValue(new Error('invalid tax id'))
    await expect(addBillingTaxId(ctx, { type: 'eu_vat', value: 'invalid' })).rejects.toThrow()
    expect(customers.deleteTaxId).not.toHaveBeenCalled()
  })
  it.concurrent.each(['fake', 'fo_vat', 'gi_tin', 'it_cf', 'py_ruc'])('rejects tax ID type %s unsupported by the pinned API before Stripe', async (type) => {
    const { ctx, customers } = context()
    await expect(addBillingTaxId(ctx, { type, value: '123' })).rejects.toMatchObject({ cause: { error: 'invalid_tax_id' } })
    expect(customers.createTaxId).not.toHaveBeenCalled()
  })
  it.concurrent('scopes deletion to the resolved customer', async () => {
    const { ctx, customers } = context()
    await removeBillingTaxId(ctx, 'txi_example')
    expect(customers.deleteTaxId).toHaveBeenCalledWith('cus_example', 'txi_example')
    await expect(removeBillingTaxId(ctx, '../cus_other')).rejects.toThrow()
  })
})
