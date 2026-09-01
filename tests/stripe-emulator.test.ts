import type Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createEmulator } from 'emulate'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCheckout, createOneTimeCheckout, getCreditCheckoutDetails, getStripe } from '../supabase/functions/_backend/utils/stripe.ts'

const { mockedSupabaseAdmin } = vi.hoisted(() => ({
  mockedSupabaseAdmin: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: mockedSupabaseAdmin,
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-emulator-test' : undefined,
  } as any
}

function stubStripeEnv(baseUrl: string) {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_emulator')
  vi.stubEnv('STRIPE_API_BASE_URL', baseUrl)
  vi.stubEnv('WEBAPP_URL', 'https://capgo.test')
}

function expectCheckoutUrlOnEmulator(url: string, baseUrl: string) {
  const checkoutUrl = new URL(url)
  const emulatorUrl = new URL(baseUrl)

  expect(checkoutUrl.port).toBe(emulatorUrl.port)
  expect(checkoutUrl.pathname).toMatch(/^\/checkout\/cs_/)
}

function mockStripeDbLookups(priceMonthId: string, priceYearId: string) {
  const rowResult = {
    maybeSingle: vi.fn().mockResolvedValue({
      data: { billing_account: 'ee' },
      error: null,
    }),
    single: vi.fn().mockResolvedValue({
      data: {
        billing_account: 'ee',
        price_m_id: priceMonthId,
        price_y_id: priceYearId,
        price_m_id_us: null,
        price_y_id_us: null,
        stripe_id: 'plan_test',
        stripe_id_us: null,
      },
      error: null,
    }),
  }

  mockedSupabaseAdmin.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => rowResult),
      })),
    })),
  })
}

function mockBillingAccountLookup() {
  mockedSupabaseAdmin.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { billing_account: 'ee' },
            error: null,
          }),
        })),
      })),
    })),
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a free port for the Stripe emulator')))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
    server.on('error', reject)
  })
}

async function startStripeEmulatorWithRetry(maxAttempts = 5) {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await getFreePort()

    try {
      const instance = await createEmulator({
        service: 'stripe' as any,
        port,
      })

      return {
        baseUrl: `http://127.0.0.1:${port}`,
        instance,
      }
    }
    catch (error) {
      const emulatorError = error instanceof Error ? error : new Error(String(error))
      const errorCode = typeof error === 'object' && error !== null && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined

      lastError = emulatorError

      if (errorCode !== 'EADDRINUSE')
        throw emulatorError
    }
  }

  throw lastError ?? new Error('Failed to start Stripe emulator')
}

describe('stripe emulator integration', () => {
  let emulator: Awaited<ReturnType<typeof createEmulator>> | undefined
  let stripeApiBaseUrl = ''

  beforeAll(async () => {
    const started = await startStripeEmulatorWithRetry()
    stripeApiBaseUrl = started.baseUrl
    emulator = started.instance
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    mockedSupabaseAdmin.mockReset()
  })

  afterAll(async () => {
    if (emulator)
      await emulator.close()
  })

  it('creates subscription checkout sessions through emulate using stored plan prices', async () => {
    stubStripeEnv(stripeApiBaseUrl)

    const context = createContext()
    const stripe = getStripe(context)
    const shortId = randomUUID().replaceAll('-', '').slice(0, 12)

    const customer = await stripe.customers.create({
      email: `checkout-${shortId}@capgo.app`,
      name: 'Checkout Emulator Test',
    })
    const product = await stripe.products.create({
      name: `Plan ${shortId}`,
    })
    const monthlyPrice = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 1200,
      recurring: {
        interval: 'month',
        usage_type: 'licensed',
      },
    })
    const yearlyPrice = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 12000,
      recurring: {
        interval: 'year',
        usage_type: 'licensed',
      },
    })

    mockStripeDbLookups(monthlyPrice.id, yearlyPrice.id)

    const checkout = await createCheckout(
      context,
      customer.id,
      'month',
      product.id,
      '/settings/organization/plans',
      '/settings/organization/plans',
    )

    expect(checkout.url).toBeTruthy()
    expectCheckoutUrlOnEmulator(checkout.url as string, stripeApiBaseUrl)
    expect(mockedSupabaseAdmin).toHaveBeenCalledTimes(2)

    const sessions = await stripe.checkout.sessions.list({ limit: 10 })
    const session = sessions.data.find(candidate => candidate.url === checkout.url)

    expect(session).toMatchObject({
      customer: customer.id,
      mode: 'subscription',
      success_url: 'https://capgo.test/settings/organization/plans?success=true',
      cancel_url: 'https://capgo.test/settings/organization/plans',
    })
  })

  it('falls back to checkout metadata when emulate does not implement line item reads', async () => {
    stubStripeEnv(stripeApiBaseUrl)

    const context = createContext()
    const stripe = getStripe(context)
    const shortId = randomUUID().replaceAll('-', '').slice(0, 12)

    const customer = await stripe.customers.create({
      email: `credits-${shortId}@capgo.app`,
      name: 'Credits Emulator Test',
    })
    const product = await stripe.products.create({
      name: `Credits ${shortId}`,
    })
    const oneTimePrice = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 100,
    })

    mockBillingAccountLookup()

    const checkout = await createOneTimeCheckout(
      context,
      customer.id,
      product.id,
      75,
      '/settings/organization/credits',
      '/settings/organization/credits',
      `org_${shortId}`,
    )

    expect(checkout.url).toBeTruthy()
    expectCheckoutUrlOnEmulator(checkout.url as string, stripeApiBaseUrl)

    const sessions = await stripe.checkout.sessions.list({ limit: 10 })
    const session = sessions.data.find(candidate => candidate.url === checkout.url) as Stripe.Checkout.Session | undefined

    expect(session).toMatchObject({
      customer: customer.id,
      mode: 'payment',
      metadata: expect.objectContaining({
        intendedQuantity: '75',
        orgId: `org_${shortId}`,
        productId: product.id,
      }),
    })
    expect(oneTimePrice.id).toMatch(/^price_/)

    const details = await getCreditCheckoutDetails(context, session as Stripe.Checkout.Session, product.id)
    expect(details).toEqual({
      creditQuantity: 75,
      itemsSummary: [
        {
          id: null,
          quantity: 75,
          priceId: null,
          productId: product.id,
        },
      ],
    })
  })
})
