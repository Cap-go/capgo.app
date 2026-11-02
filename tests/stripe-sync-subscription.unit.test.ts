import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stripeApi = vi.hoisted(() => ({
  retrieve: vi.fn(),
  list: vi.fn(),
}))

const billingMocks = vi.hoisted(() => ({
  getBillingAccountForCustomer: vi.fn(async () => 'ee' as const),
}))

const dbMocks = vi.hoisted(() => ({
  updateCalls: [] as Record<string, unknown>[],
  currentStripeInfo: { status: 'succeeded', past_due_at: null as string | null },
}))

const mockedEnv: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_123',
}

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: () => mockedEnv,
  }
})

vi.mock('stripe', () => {
  class StripeInvalidRequestError extends Error {
    code?: string
    constructor(opts: { message?: string, code?: string }) {
      super(opts.message ?? 'invalid request')
      this.code = opts.code
    }
  }
  class StripeRateLimitError extends Error {}
  const MockStripe: any = vi.fn()
  MockStripe.createFetchHttpClient = vi.fn()
  MockStripe.errors = {
    StripeAuthenticationError: class StripeAuthenticationError extends Error {},
    StripeInvalidRequestError,
    StripePermissionError: class StripePermissionError extends Error {},
    StripeRateLimitError,
  }
  return { default: MockStripe }
})

vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe_billing.ts')>()
  return {
    ...actual,
    getBillingAccountForCustomer: billingMocks.getBillingAccountForCustomer,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  servicePrincipal: { kind: 'service' },
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => run({
    query: async (text: string, values?: unknown[]) => {
      if (text.startsWith('SELECT status')) {
        return { rows: [dbMocks.currentStripeInfo] }
      }
      if (text.startsWith('UPDATE public.stripe_info')) {
        const update: Record<string, unknown> = { customer_id: values?.[0] }
        const assignments = text.match(/"([^"]+)" = \$\d+/g) ?? []
        assignments.forEach((assignment, index) => {
          const column = assignment.match(/"([^"]+)"/)?.[1]
          if (column)
            update[column] = values?.[index + 1]
        })
        dbMocks.updateCalls.push(update)
        return { rowCount: 1 }
      }
      throw new Error(`unexpected query: ${text}`)
    },
  }),
  queryJson: async (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }, text: string, values?: unknown[]) => (await client.query(text, values)).rows,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

function activeSubscription(id = 'sub_live') {
  return {
    id,
    status: 'active',
    cancel_at_period_end: false,
    latest_invoice: null,
    metadata: {},
    items: {
      data: [{
        id: 'si_1',
        plan: { usage_type: 'licensed' },
        current_period_start: 1_700_000_000,
        current_period_end: 1_700_086_400,
        price: { product: 'prod_team' },
      }],
    },
  }
}

function createContext() {
  return { get: (key: string) => key === 'requestId' ? 'stripe-sync-subscription-test' : undefined } as any
}

async function loadStripeModule() {
  vi.resetModules()
  vi.mocked(Stripe).mockImplementation(function () {
    return {
      subscriptions: {
        retrieve: stripeApi.retrieve,
        list: stripeApi.list,
      },
    }
  } as any)
  return import('../supabase/functions/_backend/utils/stripe.ts')
}

describe('stripe subscription sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMocks.updateCalls = []
    dbMocks.currentStripeInfo = { status: 'succeeded', past_due_at: null }
    stripeApi.retrieve.mockReset()
    stripeApi.list.mockReset()
    stripeApi.list.mockResolvedValue({ data: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves stripe_info unchanged when Stripe subscription retrieve fails', async () => {
    stripeApi.retrieve.mockRejectedValue(new Error('upstream timeout'))
    const { syncSubscriptionData } = await loadStripeModule()

    await syncSubscriptionData(createContext(), 'cus_read_error', 'sub_stored')

    expect(dbMocks.updateCalls).toEqual([])
  })

  it('still writes canceled when Stripe confirms the subscription is canceled', async () => {
    stripeApi.retrieve.mockResolvedValue({
      ...activeSubscription('sub_canceled'),
      status: 'canceled',
      ended_at: 1_700_000_000,
    })
    stripeApi.list.mockResolvedValue({ data: [] })
    const { syncSubscriptionData } = await loadStripeModule()

    await syncSubscriptionData(createContext(), 'cus_canceled', 'sub_canceled')

    expect(dbMocks.updateCalls.at(-1)?.status).toBe('canceled')
  })

  it('still writes canceled when Stripe returns resource_missing', async () => {
    const { StripeInvalidRequestError } = Stripe.errors
    stripeApi.retrieve.mockRejectedValue(new StripeInvalidRequestError({ message: 'missing', code: 'resource_missing' }))
    stripeApi.list.mockResolvedValue({ data: [] })
    const { syncSubscriptionData } = await loadStripeModule()

    await syncSubscriptionData(createContext(), 'cus_missing', 'sub_missing')

    expect(dbMocks.updateCalls.at(-1)?.status).toBe('canceled')
  })

  it('retries Stripe rate-limit errors with backoff before succeeding', async () => {
    const { StripeRateLimitError } = Stripe.errors
    const rateLimitError = new StripeRateLimitError({ message: 'Too many requests' } as any)
    stripeApi.retrieve
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(activeSubscription())
    stripeApi.list.mockResolvedValue({ data: [] })
    const { callStripeWithRetry, syncSubscriptionData } = await loadStripeModule()

    const sleeps: number[] = []
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (typeof handler === 'function')
        handler()
      sleeps.push(timeout ?? 0)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)

    await callStripeWithRetry(createContext(), async () => {
      return stripeApi.retrieve('sub_rate')
    })
    expect(stripeApi.retrieve).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([250, 500])

    stripeApi.retrieve.mockClear()
    stripeApi.retrieve
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(activeSubscription())
    dbMocks.updateCalls = []
    await syncSubscriptionData(createContext(), 'cus_rate', 'sub_rate')
    expect(stripeApi.retrieve).toHaveBeenCalledTimes(2)
    expect(dbMocks.updateCalls.at(-1)?.status).toBe('succeeded')

    sleepSpy.mockRestore()
  })
})
