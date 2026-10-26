import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockedEnv: Record<string, string> = {
  ENV: 'local',
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

function createContext(country = 'FR') {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    req: { raw: { cf: { country } }, header: () => undefined },
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

// createCheckout reads the plan price currencies and the customer's pinned currency.
function subscriptionCheckoutMocks(customerCurrency: string | null = null, currencyOptions: Record<string, { unit_amount: number }> = { usd: { unit_amount: 1400 } }) {
  return {
    retrievePrice: vi.fn().mockResolvedValue({ id: 'price_1', currency: 'usd', unit_amount: 1400, currency_options: currencyOptions }),
    customers: { retrieve: vi.fn().mockResolvedValue({ id: 'cus_123', currency: customerCurrency }) },
  }
}

function mockBillingAccountLookup(billingAccount = 'ee') {
  mockedSupabaseAdmin.mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { billing_account: billingAccount },
            error: null,
          }),
        }),
        or: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: null,
          }),
        }),
      }),
    }),
  })
}

afterEach(() => {
  delete mockedEnv.STRIPE_API_BASE_URL
  delete mockedEnv.STRIPE_PUBLISHABLE_KEY
  mockedEnv.ENV = 'local'
  mockedEnv.STRIPE_SECRET_KEY = 'sk_test_123'
  mockedSupabaseAdmin.mockReset()
  vi.restoreAllMocks()
})

describe('stripe redirect URL allowlist', () => {
  beforeEach(() => {
    mockBillingAccountLookup()
  })

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

  it('returns empty portal url when stripe is not configured for the billing account', async () => {
    mockedEnv.STRIPE_SECRET_KEY = ''

    const createSession = vi.fn()
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        billingPortal: {
          sessions: { create: createSession },
        },
      } as any
    } as any)

    const { createPortal } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createPortal(createContext(), 'cus_123', '/app/usage')

    expect(result.url).toBe('')
    expect(createSession).not.toHaveBeenCalled()
  })

  it('fails loudly when a US customer has no US Stripe key', async () => {
    mockBillingAccountLookup('us')
    const createSession = vi.fn()
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        billingPortal: {
          sessions: { create: createSession },
        },
      } as any
    } as any)

    const { createPortal, createCheckout, cancelSubscription } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const { BillingAccountUnavailableError } = await import('../supabase/functions/_backend/utils/stripe_billing.ts')

    const portalError = await createPortal(createContext(), 'cus_us', '/app/usage').catch(error => error)
    expect(portalError.cause).toMatchObject({ error: 'billing_account_unavailable' })
    const checkoutError = await createCheckout(createContext(), 'cus_us', 'month', 'prod_test', '/app/usage', '/app/usage').catch(error => error)
    expect(checkoutError.cause).toMatchObject({ error: 'billing_account_unavailable' })
    await expect(cancelSubscription(createContext(), 'cus_us')).rejects.toBeInstanceOf(BillingAccountUnavailableError)
    expect(createSession).not.toHaveBeenCalled()
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
    const mocks = subscriptionCheckoutMocks()
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({ data: createPriceList() }),
        retrieve: mocks.retrievePrice,
      },
      customers: mocks.customers,
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
      'prod_test',
      '/app/success',
      '/app/cancel',
      {
        clientReferenceId: 'org_123',
        attributionId: 'legacy_visitor_123',
        datafastAttribution: {
          visitorId: 'visitor_123',
          sessionId: 'session_123',
        },
        affonsoReferral: 'affonso_ref_123',
      },
    )

    expect(result.url).toBe('https://pay.capgo.test/p/pay')
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      allow_promotion_codes: true,
      success_url: 'https://capgo.test/app/success?success=true',
      cancel_url: 'https://capgo.test/app/cancel',
      client_reference_id: 'org_123',
      saved_payment_method_options: {
        allow_redisplay_filters: ['always', 'limited', 'unspecified'],
      },
      metadata: {
        attribution_id: 'legacy_visitor_123',
        datafast_visitor_id: 'visitor_123',
        datafast_session_id: 'session_123',
        affonso_referral: 'affonso_ref_123',
      },
    }))
  })

  it('creates an embedded checkout session when a publishable key is configured', async () => {
    mockedEnv.STRIPE_PUBLISHABLE_KEY = 'pk_test_123'
    const createSession = vi.fn().mockResolvedValue({ id: 'cs_test_123', url: null, client_secret: 'cs_test_123_secret' })
    vi.mocked(Stripe).mockImplementation(function () {
      const mocks = subscriptionCheckoutMocks()
      return {
        prices: { list: vi.fn().mockResolvedValue({ data: createPriceList() }), retrieve: mocks.retrievePrice },
        customers: mocks.customers,
        checkout: { sessions: { create: createSession } },
      }
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createCheckout(createContext(), 'cus_123', 'month', 'prod_test', '/app/success', '/app/cancel', { embedded: true })

    expect(result).toEqual({ url: null, clientSecret: 'cs_test_123_secret', publishableKey: 'pk_test_123', sessionId: 'cs_test_123' })
    const params = createSession.mock.calls[0][0]
    expect(params).toMatchObject({
      ui_mode: 'embedded_page',
      redirect_on_completion: 'if_required',
      return_url: 'https://capgo.test/app/success?success=true&session_id={CHECKOUT_SESSION_ID}',
    })
    expect(params).not.toHaveProperty('success_url')
    expect(params).not.toHaveProperty('cancel_url')
  })

  it('checks out in the selected Stripe currency, and keeps a billed customer on theirs', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'cs_test_123', url: 'https://pay.capgo.test/p/pay' })
    let customerCurrency: string | null = null
    vi.mocked(Stripe).mockImplementation(function () {
      const mocks = subscriptionCheckoutMocks(customerCurrency, { usd: { unit_amount: 1400 }, eur: { unit_amount: 1400 } })
      return {
        prices: { list: vi.fn().mockResolvedValue({ data: createPriceList() }), retrieve: mocks.retrievePrice },
        customers: mocks.customers,
        checkout: { sessions: { create: createSession } },
      }
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const checkout = (currency?: string, country = 'FR') => createCheckout(createContext(country), 'cus_123', 'month', 'prod_test', '/app/success', '/app/cancel', { currency })

    await checkout('EUR')
    expect(createSession.mock.calls.at(-1)?.[0]).toMatchObject({ currency: 'eur' })
    await checkout('usd')
    expect(createSession.mock.calls.at(-1)?.[0]).toMatchObject({ currency: 'usd' })
    await checkout()
    expect(createSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('currency')
    await expect(checkout('gbp', 'GB')).rejects.toMatchObject({ cause: { error: 'invalid_currency' } })
    // Any currency the price is sold in, wherever the visitor is.
    await checkout('eur', 'IN')
    expect(createSession.mock.calls.at(-1)?.[0]).toMatchObject({ currency: 'eur' })

    customerCurrency = 'usd'
    await checkout()
    expect(createSession.mock.calls.at(-1)?.[0]).toMatchObject({ currency: 'usd' })
    await expect(checkout('eur')).rejects.toMatchObject({ cause: { error: 'currency_locked' } })
  })

  it('keeps hosted checkout when embedded is requested without a publishable key', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'cs_test_123', url: 'https://pay.capgo.test/p/pay' })
    vi.mocked(Stripe).mockImplementation(function () {
      const mocks = subscriptionCheckoutMocks()
      return {
        prices: { list: vi.fn().mockResolvedValue({ data: createPriceList() }), retrieve: mocks.retrievePrice },
        customers: mocks.customers,
        checkout: { sessions: { create: createSession } },
      }
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createCheckout(createContext(), 'cus_123', 'month', 'prod_test', '/app/success', '/app/cancel', { embedded: true })

    expect(result).toEqual({ url: 'https://pay.capgo.test/p/pay' })
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('ui_mode')
  })

  it('keeps the credit session placeholder on embedded one-time checkout', async () => {
    mockedEnv.STRIPE_PUBLISHABLE_KEY = 'pk_test_123'
    const createSession = vi.fn().mockResolvedValue({ id: 'cs_test_456', url: null, client_secret: 'cs_test_456_secret' })
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        prices: { list: vi.fn().mockResolvedValue({ data: createPriceList('month', 'one_time') }) },
        checkout: { sessions: { create: createSession } },
      }
    } as any)

    const { createOneTimeCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const result = await createOneTimeCheckout(createContext(), 'cus_123', 'prod_credit', 50, '/settings/organization/credits?creditCheckout=success&session_id={CHECKOUT_SESSION_ID}', '/settings/organization/credits', 'org_123', undefined, undefined, true)

    expect(result.clientSecret).toBe('cs_test_456_secret')
    expect(createSession.mock.calls[0][0].return_url).toBe('https://capgo.test/settings/organization/credits?creditCheckout=success&session_id={CHECKOUT_SESSION_ID}&success=true')
  })

  it('rejects external success URLs for checkout', async () => {
    const createSession = vi.fn()
    const mocks = subscriptionCheckoutMocks()
    const stripeClient = {
      prices: {
        list: vi.fn().mockResolvedValue({ data: createPriceList() }),
        retrieve: mocks.retrievePrice,
      },
      customers: mocks.customers,
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
      'prod_test',
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

  it.each([
    ['a custom loopback base URL', 'http://127.0.0.1:4510', 'sk_test_123', '127.0.0.1', 4510],
    ['host.docker.internal for the Playwright emulator', 'http://host.docker.internal:4520', 'sk_test_emulator', 'host.docker.internal', 4520],
  ])('uses %s as the Stripe API base URL', async (_label, baseUrl, secretKey, host, port) => {
    mockedEnv.STRIPE_API_BASE_URL = baseUrl
    mockedEnv.STRIPE_SECRET_KEY = secretKey
    vi.mocked(Stripe).mockImplementation(function () {
      return { checkout: { sessions: {} } }
    } as any)

    const { getStripe } = await import('../supabase/functions/_backend/utils/stripe.ts')
    getStripe(createContext())

    expect(Stripe).toHaveBeenCalledWith(secretKey, expect.objectContaining({ host, port, protocol: 'http' }))
  })

  it.each([
    ['live credentials', 'http://host.docker.internal:4520', 'sk_live_123', 'local', 'STRIPE_API_BASE_URL must use https when using live Stripe credentials'],
    ['host.docker.internal outside local emulator config', 'http://host.docker.internal:4520', 'sk_test_123', 'production', 'STRIPE_API_BASE_URL host.docker.internal is only allowed for local emulator config'],
    ['non-loopback hosts', 'http://stripe.example.com', 'sk_test_123', 'local', 'STRIPE_API_BASE_URL must use https for non-loopback hosts'],
  ])('rejects an http Stripe API base URL for %s', async (_label, baseUrl, secretKey, envName, message) => {
    mockedEnv.STRIPE_API_BASE_URL = baseUrl
    mockedEnv.STRIPE_SECRET_KEY = secretKey
    mockedEnv.ENV = envName

    const { getStripe } = await import('../supabase/functions/_backend/utils/stripe.ts')
    expect(() => getStripe(createContext())).toThrow(message)
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
      saved_payment_method_options: {
        allow_redisplay_filters: ['always', 'limited', 'unspecified'],
      },
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
            maybeSingle: vi.fn().mockResolvedValue({
              data: { billing_account: 'ee' },
              error: null,
            }),
          }),
          or: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                stripe_id: 'prod_test',
                price_m_id: 'price_monthly_from_plan',
                price_y_id: 'price_yearly_from_plan',
              },
              error: null,
            }),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                stripe_id: 'prod_test',
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
    const mocks = subscriptionCheckoutMocks()
    const stripeClient = {
      customers: mocks.customers,
      prices: {
        retrieve: mocks.retrievePrice,
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
      'prod_test',
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

  it.each([
    ['FR', 'price_monthly_p70'],
    ['ES', 'price_monthly_from_plan'],
    ['US', 'price_monthly_from_plan'],
  ])('sells the regional price of the visitor country (%s)', async (country, expectedPrice) => {
    const plan = {
      stripe_id: 'prod_test',
      price_m_id: 'price_monthly_from_plan',
      price_y_id: 'price_yearly_from_plan',
      // Spain (p60) has no price of its own here, so it must fall back to the full price, never a cheaper tier.
      regional_price_ids: { p70: { price_m_id: 'price_monthly_p70', price_y_id: 'price_yearly_p70' }, p50: { price_m_id: 'price_monthly_p50' } },
    }
    mockedSupabaseAdmin.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { billing_account: 'ee' }, error: null }),
          }),
          or: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: plan, error: null }),
            maybeSingle: vi.fn().mockResolvedValue({ data: plan, error: null }),
          }),
        }),
      }),
    })

    const createSession = vi.fn().mockResolvedValue({ url: 'https://pay.capgo.test/p/subscription' })
    const mocks = subscriptionCheckoutMocks()
    // Regional prices carry their tier in Stripe metadata.
    mocks.retrievePrice.mockImplementation(async (id: string) => ({ id, currency: 'usd', unit_amount: 1400, currency_options: { usd: { unit_amount: 1400 } }, metadata: id.endsWith('_p70') ? { capgo_tier: 'p70' } : {} }))
    vi.mocked(Stripe).mockImplementation(function () {
      return { customers: mocks.customers, prices: { retrieve: mocks.retrievePrice, list: vi.fn() }, checkout: { sessions: { create: createSession } } }
    } as any)

    const { createCheckout } = await import('../supabase/functions/_backend/utils/stripe.ts')
    await createCheckout(createContext(country), 'cus_123', 'month', 'prod_test', '/app/success', '/app/cancel')

    expect(mocks.retrievePrice).toHaveBeenCalledWith(expectedPrice, expect.anything())
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [expect.objectContaining({ price: expectedPrice, quantity: 1 })],
      // A regional discount needs a billing address, checked by the webhook with the card.
      billing_address_collection: expectedPrice === 'price_monthly_p70' ? 'required' : 'auto',
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
