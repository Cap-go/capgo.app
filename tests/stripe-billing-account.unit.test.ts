import Stripe from 'stripe'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockedEnv: Record<string, string> = {
  WEBAPP_URL: 'https://capgo.test',
  STRIPE_SECRET_KEY: 'sk_test_ee',
}

const { mockedSupabaseAdmin } = vi.hoisted(() => ({
  mockedSupabaseAdmin: vi.fn(),
}))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: () => mockedEnv,
  }
})

vi.mock('stripe', () => {
  const MockStripe: any = vi.fn()
  MockStripe.createFetchHttpClient = vi.fn()
  MockStripe.createSubtleCryptoProvider = vi.fn()
  MockStripe.errors = {
    StripeAuthenticationError: class StripeAuthenticationError extends Error {},
    StripeInvalidRequestError: class StripeInvalidRequestError extends Error {},
    StripePermissionError: class StripePermissionError extends Error {},
    StripeRateLimitError: class StripeRateLimitError extends Error {},
  }
  return { default: MockStripe }
})

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: mockedSupabaseAdmin,
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

function mockStripeInfoBillingAccount(billingAccount: string) {
  mockedSupabaseAdmin.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { billing_account: billingAccount },
            error: null,
          }),
        })),
      })),
    })),
  })
}

afterEach(() => {
  delete mockedEnv.STRIPE_SECRET_KEY_US
  delete mockedEnv.STRIPE_WEBHOOK_SECRET_US
  delete mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT
  mockedSupabaseAdmin.mockReset()
  vi.restoreAllMocks()
})

describe('stripe billing account scaffolding', () => {
  it('defaults new customers to EE when STRIPE_NEW_CUSTOMERS_ACCOUNT is unset', async () => {
    const { getNewCustomersBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
  })

  it('keeps new customers on EE when US secrets are missing even if flag requests US', async () => {
    mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'us'
    const { getNewCustomersBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
  })

  it('keeps new customers on EE when only US API key is set without webhook secret', async () => {
    mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'us'
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    const { getNewCustomersBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
  })

  it('keeps new customers on EE when only US webhook secret is set without API key', async () => {
    mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'us'
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_test_us'
    const { getNewCustomersBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
  })

  it('rejects prefix-only US API and webhook secrets for new customer routing', async () => {
    mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'us'
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_'
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_'
    const { getNewCustomersBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
  })

  it('routes new customers to US only when both US API key and webhook secret are configured', async () => {
    mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'us'
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_test_us'
    const { getNewCustomersBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(getNewCustomersBillingAccount(createContext())).toBe('us')
  })

  it('uses EE secret key for default getStripe()', async () => {
    vi.mocked(Stripe).mockImplementation(function () {
      return {} as any
    } as any)

    const { getStripe } = await import('../supabase/functions/_backend/utils/stripe.ts')
    getStripe(createContext())

    expect(Stripe).toHaveBeenCalledWith('sk_test_ee', expect.any(Object))
  })

  it('fails closed for US account when US secret key is missing', async () => {
    const { getStripe } = await import('../supabase/functions/_backend/utils/stripe.ts')
    expect(() => getStripe(createContext(), 'us')).toThrow(HTTPException)
  })

  it('selects US Stripe client when stripe_info.billing_account is us and US secrets exist', async () => {
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    mockStripeInfoBillingAccount('us')

    vi.mocked(Stripe).mockImplementation(function () {
      return {} as any
    } as any)

    const { resolveBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    const { getStripe } = await import('../supabase/functions/_backend/utils/stripe.ts')

    const account = await resolveBillingAccount(createContext(), 'cus_us_customer')
    expect(account).toBe('us')
    getStripe(createContext(), account)

    expect(Stripe).toHaveBeenCalledWith('sk_test_us', expect.any(Object))
  })

  it('resolveBillingAccount defaults to EE for unknown customers', async () => {
    mockedSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
      })),
    })

    const { resolveBillingAccount } = await import('../supabase/functions/_backend/utils/stripe_billing_account.ts')
    expect(await resolveBillingAccount(createContext(), 'cus_missing')).toBe('ee')
  })
})
