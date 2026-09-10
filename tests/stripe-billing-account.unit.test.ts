import { afterEach, describe, expect, it, vi } from 'vitest'

const mockedEnv: Record<string, string> = {
  STRIPE_NEW_CUSTOMERS_ACCOUNT: 'ee',
}

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: () => mockedEnv,
  }
})

import {
  getNewCustomersBillingAccount,
  getPlanCreditProductId,
  getPlanPriceId,
  getPlanProductId,
  IncompleteUsPlanConfigError,
  getStripeSecretKeyEnvName,
  getStripeWebhookSecretEnvName,
  normalizeBillingAccount,
  planProductIdOrFilter,
} from '../supabase/functions/_backend/utils/stripe_billing.ts'

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-billing-test' : undefined,
  } as any
}

afterEach(() => {
  mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'ee'
})

const SOLO_PLAN = {
  stripe_id: 'prod_LQIregjtNduh4q',
  price_m_id: 'price_1LVvuZGH46eYKnWwuGKOf4DK',
  price_y_id: 'price_1LVvuIGH46eYKnWwHMDCrxcH',
  credit_id: 'prod_TJRd2hFHZsBIPK',
  stripe_id_us: 'prod_VDt1FTF7XJxyMR',
  price_m_id_us: 'price_1UDRGPLr632EP5z4ufTRBBzf',
  price_y_id_us: 'price_1UDRGULr632EP5z4OcZr5xpe',
  credit_id_us: 'prod_VDt2YB5GrYFnII',
}

describe('stripe billing account helpers', () => {
  it('defaults new customers to ee', () => {
    expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
    const previousFlag = mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT
    try {
      mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = ''
      expect(getNewCustomersBillingAccount(createContext())).toBe('ee')
    }
    finally {
      mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = previousFlag
    }
  })

  it('routes new customers to us when flag is set', () => {
    const previousFlag = mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT
    try {
      mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'us'
      expect(getNewCustomersBillingAccount(createContext())).toBe('us')
    }
    finally {
      mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = previousFlag
    }
  })

  it('normalizes billing account values', () => {
    expect(normalizeBillingAccount('us')).toBe('us')
    expect(normalizeBillingAccount('ee')).toBe('ee')
    expect(normalizeBillingAccount(null)).toBe('ee')
  })

  it('maps env var names per account', () => {
    expect(getStripeSecretKeyEnvName('ee')).toBe('STRIPE_SECRET_KEY')
    expect(getStripeSecretKeyEnvName('us')).toBe('STRIPE_SECRET_KEY_US')
    expect(getStripeWebhookSecretEnvName('us')).toBe('STRIPE_WEBHOOK_SECRET_US')
  })

  it('resolves EE and US plan ids', () => {
    expect(getPlanProductId(SOLO_PLAN, 'ee')).toBe('prod_LQIregjtNduh4q')
    expect(getPlanProductId(SOLO_PLAN, 'us')).toBe('prod_VDt1FTF7XJxyMR')
    expect(getPlanPriceId(SOLO_PLAN, 'us', 'month')).toBe('price_1UDRGPLr632EP5z4ufTRBBzf')
    expect(getPlanPriceId(SOLO_PLAN, 'ee', 'year')).toBe('price_1LVvuIGH46eYKnWwHMDCrxcH')
    expect(getPlanCreditProductId(SOLO_PLAN, 'us')).toBe('prod_VDt2YB5GrYFnII')
  })

  it('builds dual-product lookup filter', () => {
    expect(planProductIdOrFilter('prod_VDt1FTF7XJxyMR')).toBe('stripe_id.eq.prod_VDt1FTF7XJxyMR,stripe_id_us.eq.prod_VDt1FTF7XJxyMR')
  })

  it('rejects invalid stripe product ids in lookup filter', () => {
    expect(() => planProductIdOrFilter('')).toThrow('invalid_stripe_product_id')
    expect(() => planProductIdOrFilter('price_123')).toThrow('invalid_stripe_product_id')
    expect(() => planProductIdOrFilter('prod_bad),stripe_id_us.eq.x')).toThrow('invalid_stripe_product_id')
  })

  it('rejects incomplete US plan config instead of falling back to EE ids', () => {
    const incompleteUsPlan = { ...SOLO_PLAN, stripe_id_us: null, price_m_id_us: null }
    expect(() => getPlanProductId(incompleteUsPlan, 'us')).toThrow(IncompleteUsPlanConfigError)
    expect(() => getPlanPriceId(incompleteUsPlan, 'us', 'month')).toThrow(IncompleteUsPlanConfigError)
    expect(() => getPlanCreditProductId({ ...SOLO_PLAN, credit_id_us: null }, 'us')).toThrow(IncompleteUsPlanConfigError)
    expect(() => getPlanProductId({ ...SOLO_PLAN, stripe_id_us: '   ' }, 'us')).toThrow(IncompleteUsPlanConfigError)
  })

  it('defaults to ee when admin client is unavailable but throws on lookup errors', async () => {
    const context = createContext()
    const lookupError = { message: 'connection refused', code: 'PGRST000' }

    const adminModule = await import('../supabase/functions/_backend/utils/supabase.ts')
    const billingModule = await import('../supabase/functions/_backend/utils/stripe_billing.ts')

    mockedEnv.STRIPE_NEW_CUSTOMERS_ACCOUNT = 'ee'
    const missingAdminSpy = vi.spyOn(adminModule, 'supabaseAdmin').mockReturnValueOnce(undefined as any)
    try {
      await expect(billingModule.getBillingAccountForCustomer(context, 'cus_test')).resolves.toBe('ee')
    }
    finally {
      missingAdminSpy.mockRestore()
    }

    const lookupErrorSpy = vi.spyOn(adminModule, 'supabaseAdmin').mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: lookupError }),
          }),
        }),
      }),
    } as any)
    try {
      await expect(billingModule.getBillingAccountForCustomer(context, 'cus_test')).rejects.toEqual(lookupError)
    }
    finally {
      lookupErrorSpy.mockRestore()
    }
  })
})
