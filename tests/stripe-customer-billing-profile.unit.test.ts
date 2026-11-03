import Stripe from 'stripe'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('stripe', () => {
  const MockStripe: any = vi.fn()
  MockStripe.createFetchHttpClient = vi.fn()
  MockStripe.errors = {
    StripeAuthenticationError: class StripeAuthenticationError extends Error {},
    StripeInvalidRequestError: class StripeInvalidRequestError extends Error {},
    StripePermissionError: class StripePermissionError extends Error {},
    StripeRateLimitError: class StripeRateLimitError extends Error {},
  }
  return { default: MockStripe }
})

vi.mock('../supabase/functions/_backend/utils/stripe.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe.ts')>(),
  syncStripeCustomerCountry: vi.fn().mockResolvedValue('PT'),
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'billing-profile-test' : undefined,
  } as any
}

function createCtx(stripe: Stripe, customerId = 'cus_test') {
  return {
    customerId,
    billingAccount: 'ee' as const,
    stripe,
    publishableKey: 'pk_test',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stripe customer billing profile', () => {
  it('validates supported tax id types', async () => {
    const { isStripeBillingProfileTaxIdType } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    expect(isStripeBillingProfileTaxIdType('eu_vat')).toBe(true)
    expect(isStripeBillingProfileTaxIdType('not_a_type')).toBe(false)
  })

  it('maps customer address and primary tax id', async () => {
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'cus_test',
          deleted: false,
          address: { line1: 'Rua Example 1', country: 'pt', postal_code: '9000-000' },
        }),
        listTaxIds: vi.fn().mockResolvedValue({
          data: [{ id: 'txi_1', type: 'eu_vat', value: 'PT123456789' }],
        }),
      },
    }

    const { getCustomerBillingProfile } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    const profile = await getCustomerBillingProfile(createContext(), createCtx(stripe as unknown as Stripe))

    expect(profile.address).toMatchObject({
      line1: 'Rua Example 1',
      country: 'PT',
      postalCode: '9000-000',
    })
    expect(profile.taxId).toEqual({ id: 'txi_1', type: 'eu_vat', value: 'PT123456789' })
  })

  it('reads billing profile on the US Stripe account context', async () => {
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'cus_us',
          deleted: false,
          address: { line1: '1 Main St', country: 'US', postal_code: '94105' },
        }),
        listTaxIds: vi.fn().mockResolvedValue({ data: [] }),
      },
    }

    const { getCustomerBillingProfile } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    const profile = await getCustomerBillingProfile(createContext(), {
      ...createCtx(stripe as unknown as Stripe, 'cus_us'),
      billingAccount: 'us',
    })

    expect(profile.address.country).toBe('US')
    expect(stripe.customers.retrieve).toHaveBeenCalledWith('cus_us')
  })

  it('creates a tax id before deleting the previous one', async () => {
    const createTaxId = vi.fn().mockResolvedValue({ id: 'txi_new', type: 'eu_vat', value: 'PT999999990' })
    const deleteTaxId = vi.fn().mockResolvedValue({})
    const update = vi.fn().mockResolvedValue({ id: 'cus_test', deleted: false, address: { line1: 'New', country: 'PT' } })
    const listTaxIds = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 'txi_old', type: 'eu_vat', value: 'PT123456789' }] })
      .mockResolvedValueOnce({ data: [{ id: 'txi_new', type: 'eu_vat', value: 'PT999999990' }] })
    const stripe = {
      customers: {
        update,
        createTaxId,
        deleteTaxId,
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_test', deleted: false, address: { line1: 'New', country: 'PT' } }),
        listTaxIds,
      },
    }

    const { updateCustomerBillingProfile } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    await updateCustomerBillingProfile(createContext(), createCtx(stripe as unknown as Stripe), {
      address: { line1: 'New', country: 'PT' },
      taxId: { type: 'eu_vat', value: 'PT999999990' },
    })

    expect(createTaxId.mock.invocationCallOrder[0]).toBeLessThan(deleteTaxId.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
    expect(deleteTaxId).toHaveBeenCalledWith('cus_test', 'txi_old')
    expect(update).toHaveBeenCalledWith('cus_test', { address: expect.objectContaining({ line1: 'New', country: 'PT' }) })
  })

  it('sends empty strings when optional address fields are cleared', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'cus_test', deleted: false, address: { line1: 'Main', country: 'PT' } })
    const stripe = {
      customers: {
        update,
        createTaxId: vi.fn(),
        deleteTaxId: vi.fn(),
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_test', deleted: false, address: { line1: 'Main', country: 'PT' } }),
        listTaxIds: vi.fn().mockResolvedValue({ data: [] }),
      },
    }

    const { updateCustomerBillingProfile } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    await updateCustomerBillingProfile(createContext(), createCtx(stripe as unknown as Stripe), {
      address: {
        line1: 'Main',
        line2: null,
        city: null,
        state: null,
        postalCode: null,
        country: 'PT',
      },
      taxId: null,
    })

    expect(update).toHaveBeenCalledWith('cus_test', {
      address: {
        line1: 'Main',
        line2: '',
        city: '',
        state: '',
        postal_code: '',
        country: 'PT',
      },
    })
  })

  it('preserves unsupported tax id types when clearing managed tax ids', async () => {
    const deleteTaxId = vi.fn().mockResolvedValue({})
    const stripe = {
      customers: {
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        createTaxId: vi.fn(),
        deleteTaxId,
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_test', deleted: false, address: { line1: 'Main', country: 'PT' } }),
        listTaxIds: vi.fn().mockResolvedValue({
          data: [
            { id: 'txi_jp', type: 'jp_cn', value: 'T1234567890123' },
            { id: 'txi_eu', type: 'eu_vat', value: 'PT123456789' },
          ],
        }),
      },
    }

    const { updateCustomerBillingProfile } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    await updateCustomerBillingProfile(createContext(), createCtx(stripe as unknown as Stripe), {
      address: { line1: 'Main', country: 'PT' },
      taxId: null,
    })

    expect(deleteTaxId).toHaveBeenCalledTimes(1)
    expect(deleteTaxId).toHaveBeenCalledWith('cus_test', 'txi_eu')
  })

  it('keeps the existing tax id when Stripe rejects the replacement', async () => {
    const createTaxId = vi.fn().mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ message: 'Invalid value' } as any))
    const deleteTaxId = vi.fn()
    const stripe = {
      customers: {
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        createTaxId,
        deleteTaxId,
        retrieve: vi.fn(),
        listTaxIds: vi.fn().mockResolvedValue({ data: [{ id: 'txi_old', type: 'eu_vat', value: 'PT123456789' }] }),
      },
    }

    const { updateCustomerBillingProfile } = await import('../supabase/functions/_backend/utils/stripe_customer_billing_profile.ts')
    await expect(updateCustomerBillingProfile(createContext(), createCtx(stripe as unknown as Stripe), {
      address: { line1: 'Line', country: 'PT' },
      taxId: { type: 'eu_vat', value: 'BAD' },
    })).rejects.toMatchObject({ cause: { error: 'stripe_customer_update_failed' } })

    expect(deleteTaxId).not.toHaveBeenCalled()
  })
})
