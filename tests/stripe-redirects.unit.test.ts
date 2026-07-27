import Stripe from 'stripe'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockedEnv: Record<string, string> = {
  WEBAPP_URL: 'https://capgo.test',
  STRIPE_SECRET_KEY: 'sk_test_123',
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

function createPriceList(recurringInterval = 'month', type = 'recurring') {
  return [
    {
      id: 'price_1',
      active: true,
      recurring: {
        interval: recurringInterval,
        usage_type: 'licensed',
      },
      type,
    },
  ]
}

afterEach(() => {
  delete mockedEnv.STRIPE_API_BASE_URL
  mockedSupabaseAdmin.mockReset()
  vi.restoreAllMocks()
})

describe('stripe redirect URL allowlist', () => {
  it('allows same-origin return URLs for billing portal', async () => {
    const createSession = vi.fn().mockResolvedValue({ url: 'https://pay.capgo.test/p/session' })
    const stripeClient = {
      billingPortal: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createPortal } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createPortal(createContext(), 'cus_123', '/app/usage')

    expect(result.url).toBe('https://pay.capgo.test/p/session')
    expect(createSession).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://capgo.test/app/usage',
    })
  })

  it('rejects external return URLs for billing portal', async () => {
    const createSession = vi.fn()
    const stripeClient = {
      billingPortal: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createPortal } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const response = await createPortal(createContext(), 'cus_123', 'https://example.com/phishing').catch(error => error)

    expect(response).toBeInstanceOf(Error)
    expect(response.cause).toMatchObject({ error: 'invalid_redirect_url' })
    expect(response.status).toBe(400)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('allows same-origin success and cancel URLs for checkout', async () => {
    const createSession = vi.fn().mockResolvedValue({ url: 'https://pay.capgo.test/p/pay' })
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({ data: createPriceList() }),
      },
      checkout: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createCheckout(
      createContext(),
      'cus_123',
      'month',
      'plan_test',
      '/app/success',
      '/app/cancel',
      'org_123',
      'legacy_visitor_123',
      {
        visitorId: 'visitor_123',
        sessionId: 'session_123',
      },
      'affonso_ref_123',
    )

    expect(result.url).toBe('https://pay.capgo.test/p/pay')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      allow_promotion_codes: true,
      success_url: 'https://capgo.test/app/success?success=true',
      cancel_url: 'https://capgo.test/app/cancel',
      client_reference_id: 'org_123',
      metadata: {
        attribution_id: 'legacy_visitor_123',
        datafast_visitor_id: 'visitor_123',
        datafast_session_id: 'session_123',
        affonso_referral: 'affonso_ref_123',
      },
    }))
  })

  it('rejects external success URLs for checkout', async () => {
    const createSession = vi.fn()
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({ data: createPriceList() }),
      },
      checkout: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const response = await createCheckout(
      createContext(),
      'cus_123',
      'month',
      'plan_test',
      'https://example.com/phishing',
      '/app/cancel',
    ).catch(error => error)

    expect(response.cause).toMatchObject({ error: 'invalid_redirect_url' })
    expect(response.status).toBe(400)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('rejects external cancel URLs for one-time checkout', async () => {
    const createSession = vi.fn()
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({ data: createPriceList('one_time', 'one_time') }),
      },
      checkout: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createOneTimeCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const response = await createOneTimeCheckout(
      createContext(),
      'cus_123',
      'prod_123',
      1,
      '/app/success',
      'https://example.com/phishing',
    ).catch(error => error)

    expect(response).toBeInstanceOf(Error)
    expect(response.cause).toMatchObject({ error: 'invalid_redirect_url' })
    expect(response.status).toBe(400)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('uses a custom Stripe API base URL when configured', async () => {
    mockedEnv.STRIPE_API_BASE_URL = 'http://127.0.0.1:4510'

    const stripeClient = {
      checkout: {
        sessions: {},
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { getStripe } = await import('../supabase/functions/_backend/utils/stripe.ts')
    getStripe(createContext())

    expect(Stripe).toHaveBeenCalledWith('sk_test_123', expect.objectContaining({
      host: '127.0.0.1',
      port: 4510,
      protocol: 'http',
    }))
  })

  it('falls back to checkout metadata for credit top-ups when line items are unavailable in emulator mode', async () => {
    mockedEnv.STRIPE_API_BASE_URL = 'http://127.0.0.1:4510'

    const listLineItems = vi.fn().mockRejectedValue(new Error('line_items endpoint unavailable'))
    const stripeClient = {
      checkout: {
        sessions: {
          listLineItems,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { getCreditCheckoutDetails } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const details = await getCreditCheckoutDetails(
      createContext(),
      {
        id: 'cs_test_123',
        metadata: {
          productId: 'prod_credit_123',
          intendedQuantity: '75',
        },
      } as any,
      'prod_credit_123',
    )

    expect(listLineItems).toHaveBeenCalledWith('cs_test_123', {
      expand: ['data.price.product'],
      limit: 100,
    })
    expect(details).toEqual({
      creditQuantity: 75,
      itemsSummary: [
        {
          id: null,
          quantity: 75,
          priceId: null,
          productId: 'prod_credit_123',
        },
      ],
    })
  })

  it('disables adjustable quantity for emulator-backed one-time checkout sessions', async () => {
    mockedEnv.STRIPE_API_BASE_URL = 'http://127.0.0.1:4510'

    const createSession = vi.fn().mockResolvedValue({ url: 'https://pay.capgo.test/p/pay' })
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({ data: createPriceList('one_time', 'one_time') }),
      },
      checkout: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createOneTimeCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    await createOneTimeCheckout(
      createContext(),
      'cus_123',
      'prod_123',
      5,
      '/app/success',
      '/app/cancel',
      'org_123',
      {
        visitorId: 'visitor_456',
        sessionId: 'session_456',
      },
      'affonso_ref_456',
    )

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [
        expect.not.objectContaining({
          adjustable_quantity: expect.anything(),
        }),
      ],
      metadata: expect.objectContaining({
        datafast_visitor_id: 'visitor_456',
        datafast_session_id: 'session_456',
        affonso_referral: 'affonso_ref_456',
        intendedQuantity: '5',
        orgId: 'org_123',
      }),
    }))
  })

  it('falls back to stored plan price ids when the Stripe emulator omits recurring metadata', async () => {
    mockedEnv.STRIPE_API_BASE_URL = 'http://127.0.0.1:4510'

    mockedSupabaseAdmin.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                price_m_id: 'price_monthly_from_plan',
                price_y_id: 'price_yearly_from_plan',
              },
              error: null,
            }),
          }),
        }),
      }),
    })

    const createSession = vi.fn().mockResolvedValue({ url: 'https://pay.capgo.test/p/subscription' })
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'price_missing_recurring_metadata',
              active: true,
              type: 'recurring',
            },
          ],
        }),
      },
      checkout: {
        sessions: {
          create: createSession,
        },
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createCheckout(
      createContext(),
      'cus_123',
      'month',
      'plan_test',
      '/app/success',
      '/app/cancel',
    )

    expect(result.url).toBe('https://pay.capgo.test/p/subscription')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [
        expect.objectContaining({
          price: 'price_monthly_from_plan',
          quantity: 1,
        }),
      ],
    }))
  })

  it('updates Stripe customer email without overwriting the organization name', async () => {
    const updateCustomer = vi.fn().mockResolvedValue({ id: 'cus_123' })
    const stripeClient = {
      customers: {
        update: updateCustomer,
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { updateCustomerEmail } = await import('../supabase/functions/_backend/utils/stripe.ts')
    await updateCustomerEmail(createContext(), 'cus_123', 'billing@capgo.app')

    expect(updateCustomer).toHaveBeenCalledWith('cus_123', {
      email: 'billing@capgo.app',
      metadata: {
        email: 'billing@capgo.app',
      },
    })
  })

  it('updates Stripe customer name when the organization name changes', async () => {
    const updateCustomer = vi.fn().mockResolvedValue({ id: 'cus_123' })
    const stripeClient = {
      customers: {
        update: updateCustomer,
      },
    } as any

    vi.mocked(Stripe).mockImplementation(function () {
      return stripeClient
    } as any)

    const { updateCustomerOrganizationName } = await import('../supabase/functions/_backend/utils/stripe.ts')
    await updateCustomerOrganizationName(createContext(), 'cus_123', 'Capgo Org')

    expect(updateCustomer).toHaveBeenCalledWith('cus_123', {
      name: 'Capgo Org',
    })
  })

  it('treats Stripe rate-limit errors as deterministic customer update failures', async () => {
    const { isDeterministicStripeCustomerUpdateError } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const rateLimitError = new Stripe.errors.StripeRateLimitError({ message: 'rate limited' } as any)

    expect(isDeterministicStripeCustomerUpdateError(rateLimitError)).toBe(true)
  })
})
