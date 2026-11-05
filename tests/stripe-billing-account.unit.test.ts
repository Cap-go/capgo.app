import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canChooseUsBillingAccount,
  getPlanCreditProductId,
  getPlanPriceId,
  getPlanProductId,
  getRequestCountry,
  getStripeSecretKeyEnvName,
  getStripeWebhookSecretEnvName,
  getSuggestedBillingAccount,
  IncompleteUsPlanConfigError,
  isAutomaticTaxEnabled,
  normalizeBillingAccount,
  planProductIdOrFilter,
  resolveCheckoutPlanProductId,
  resolveNewOrgBillingAccount,
  resolvePlanCreditProductId,
} from '../supabase/functions/_backend/utils/stripe_billing.ts'
import { isUsBillingCountry } from '../supabase/functions/_backend/utils/us_billing_countries.ts'

const mockedEnv: Record<string, string> = {}

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: () => mockedEnv,
  }
})

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-billing-test' : undefined,
  } as any
}

function createGeoContext(country?: string, header?: string) {
  return {
    get: () => undefined,
    req: {
      raw: country ? { cf: { country } } : {},
      header: (name: string) => name === 'cf-ipcountry' ? header : undefined,
    },
  } as any
}

afterEach(() => {
  delete mockedEnv.STRIPE_SECRET_KEY_US
  delete mockedEnv.STRIPE_WEBHOOK_SECRET_US
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
    expect(resolvePlanCreditProductId({ ...SOLO_PLAN, credit_id_us: null }, 'us')).toBe('')
  })

  it('builds dual-product lookup filter', () => {
    expect(planProductIdOrFilter('prod_VDt1FTF7XJxyMR')).toBe('stripe_id.eq.prod_VDt1FTF7XJxyMR,stripe_id_us.eq.prod_VDt1FTF7XJxyMR')
  })

  it('rejects invalid stripe product ids in lookup filter', () => {
    expect(() => planProductIdOrFilter('')).toThrow('invalid_stripe_product_id')
    expect(() => planProductIdOrFilter('price_123')).toThrow('invalid_stripe_product_id')
    expect(() => planProductIdOrFilter('prod_bad),stripe_id_us.eq.x')).toThrow('invalid_stripe_product_id')
    expect(planProductIdOrFilter('prod_solo_us')).toBe('stripe_id.eq.prod_solo_us,stripe_id_us.eq.prod_solo_us')
    expect(planProductIdOrFilter('prod_cHwBt-3ULYAoLArt')).toBe('stripe_id.eq.prod_cHwBt-3ULYAoLArt,stripe_id_us.eq.prod_cHwBt-3ULYAoLArt')
  })

  it('rejects incomplete US plan config instead of falling back to EE ids', () => {
    const incompleteUsPlan = { ...SOLO_PLAN, stripe_id_us: null, price_m_id_us: null }
    expect(() => getPlanProductId(incompleteUsPlan, 'us')).toThrow(IncompleteUsPlanConfigError)
    expect(() => getPlanPriceId(incompleteUsPlan, 'us', 'month')).toThrow(IncompleteUsPlanConfigError)
    expect(() => getPlanCreditProductId({ ...SOLO_PLAN, credit_id_us: null }, 'us')).toThrow(IncompleteUsPlanConfigError)
    expect(() => getPlanProductId({ ...SOLO_PLAN, stripe_id_us: '   ' }, 'us')).toThrow(IncompleteUsPlanConfigError)
  })

  it('throws on billing account lookup errors', async () => {
    const context = createContext()
    const lookupError = { message: 'connection refused', code: 'PGRST000' }

    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')
    const billingModule = await import('../supabase/functions/_backend/utils/stripe_billing.ts')

    const lookupErrorSpy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementationOnce(async () => {
      throw lookupError
    })
    try {
      await expect(billingModule.getBillingAccountForCustomer(context, 'cus_test')).rejects.toEqual(lookupError)
    }
    finally {
      lookupErrorSpy.mockRestore()
    }
  })

  it('rejects US checkout for products missing from plans', async () => {
    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')
    const spy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementation(async (_c, _principal, run) => run({
      query: async () => ({ rows: [] }),
    } as any, {} as any))
    try {
      await expect(resolveCheckoutPlanProductId(createContext(), 'prod_unknown', 'us')).rejects.toBeInstanceOf(IncompleteUsPlanConfigError)
      await expect(resolveCheckoutPlanProductId(createContext(), 'prod_unknown', 'ee')).resolves.toBe('prod_unknown')
    }
    finally {
      spy.mockRestore()
    }
  })

  it('propagates plan lookup errors before selecting checkout product id', async () => {
    const context = createContext()
    const lookupError = { message: 'connection refused', code: 'PGRST000' }
    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')

    const lookupErrorSpy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementation(async () => {
      throw lookupError
    })
    try {
      await expect(resolveCheckoutPlanProductId(context, 'prod_test', 'ee')).rejects.toEqual(lookupError)
    }
    finally {
      lookupErrorSpy.mockRestore()
    }
  })
})

describe('new org billing account from location', () => {
  it('reads the request country from Cloudflare or the cf-ipcountry header', () => {
    expect(getRequestCountry(createGeoContext('US'))).toBe('US')
    expect(getRequestCountry(createGeoContext(undefined, 'us'))).toBe('US')
    expect(getRequestCountry(createGeoContext(undefined, 'XX1'))).toBeNull()
    expect(getRequestCountry(createGeoContext())).toBeNull()
  })

  it('suggests us for US visitors only when the US account is configured', () => {
    expect(getSuggestedBillingAccount(createGeoContext('US'))).toBe('ee')
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    // Key without webhook secret: US webhooks would not sync, stay on ee.
    expect(getSuggestedBillingAccount(createGeoContext('US'))).toBe('ee')
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_test_us'
    expect(getSuggestedBillingAccount(createGeoContext('US'))).toBe('us')
    expect(getSuggestedBillingAccount(createGeoContext('FR'))).toBe('ee')
  })

  it('lets the user choice override the suggestion', () => {
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_test_us'
    expect(resolveNewOrgBillingAccount(createGeoContext('US'), 'ee')).toBe('ee')
    expect(resolveNewOrgBillingAccount(createGeoContext('US'), 'us')).toBe('us')
  })

  it('defaults offered visitors to us and everyone else to ee', () => {
    expect(resolveNewOrgBillingAccount(createGeoContext('US'))).toBe('ee')
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_test_us'
    expect(resolveNewOrgBillingAccount(createGeoContext('US'))).toBe('us')
    expect(resolveNewOrgBillingAccount(createGeoContext('FR'))).toBe('ee')
    expect(resolveNewOrgBillingAccount(createGeoContext())).toBe('ee')
  })

  it('offers the US entity in the Americas and Asia-Pacific only', () => {
    mockedEnv.STRIPE_SECRET_KEY_US = 'sk_test_us'
    mockedEnv.STRIPE_WEBHOOK_SECRET_US = 'whsec_test_us'
    for (const country of ['US', 'CA', 'BR', 'MX', 'JP', 'AU', 'IN', 'SG', 'TK'])
      expect(canChooseUsBillingAccount(createGeoContext(country))).toBe(true)
    for (const country of ['FR', 'DE', 'GB', 'CH', 'AE', 'ZA', 'NG', 'GF', 'CU', 'KP', 'AF', 'KZ', 'UZ'])
      expect(canChooseUsBillingAccount(createGeoContext(country))).toBe(false)
    expect(canChooseUsBillingAccount(createGeoContext())).toBe(false)
    expect(isUsBillingCountry('ca')).toBe(true)
    expect(isUsBillingCountry(null)).toBe(false)
    expect(getSuggestedBillingAccount(createGeoContext('JP'))).toBe('us')
    // US bills without automatic tax, so a European caller cannot pick it through the API.
    expect(resolveNewOrgBillingAccount(createGeoContext('FR'), 'us')).toBe('ee')
    expect(resolveNewOrgBillingAccount(createGeoContext('BR'), 'us')).toBe('us')
  })

  it('falls back to ee when us is requested but not configured', () => {
    expect(resolveNewOrgBillingAccount(createGeoContext('US'), 'us')).toBe('ee')
  })
})

describe('isAutomaticTaxEnabled', () => {
  it('collects tax only on the ee account', () => {
    expect(isAutomaticTaxEnabled('ee')).toBe(true)
    expect(isAutomaticTaxEnabled('us')).toBe(false)
  })
})
