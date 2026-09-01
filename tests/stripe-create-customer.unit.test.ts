import Stripe from 'stripe'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockedEnv: Record<string, string> = {
  WEBAPP_URL: 'https://capgo.test',
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

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'create-customer-test' : undefined,
  } as any
}

afterEach(() => {
  mockedEnv.STRIPE_SECRET_KEY = 'sk_test_123'
  vi.restoreAllMocks()
})

describe('createCustomer idempotency', () => {
  it('passes a stable org-scoped Stripe idempotency key', async () => {
    const createCustomerApi = vi.fn().mockResolvedValue({ id: 'cus_idempotent' })
    const updateCustomerApi = vi.fn().mockResolvedValue({ id: 'cus_idempotent' })
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        customers: {
          create: createCustomerApi,
          update: updateCustomerApi,
        },
      }
    } as any)

    const { createCustomer, orgStripeCustomerIdempotencyKey } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const orgId = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
    const customer = await createCustomer(createContext(), 'owner@example.com', 'user-1', orgId, 'WN Hub')

    expect(customer.id).toBe('cus_idempotent')
    expect(orgStripeCustomerIdempotencyKey(orgId)).toBe(`org-customer:${orgId}`)
    expect(createCustomerApi).toHaveBeenCalledWith({
      email: 'owner@example.com',
      name: 'WN Hub',
      metadata: expect.objectContaining({
        org_id: orgId,
        user_id: 'user-1',
      }),
    }, { idempotencyKey: `org-customer:${orgId}` })
  })

  it('returns a deterministic local customer id when Stripe is not configured', async () => {
    mockedEnv.STRIPE_SECRET_KEY = ''
    const { createCustomer } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const orgId = '48cf992a-c9ac-4591-863e-28fdccebdc30'

    const first = await createCustomer(createContext(), 'a@example.com', 'user-1', orgId, 'Lock Media LLC')
    const second = await createCustomer(createContext(), 'a@example.com', 'user-1', orgId, 'Lock Media LLC')

    expect(first.id).toBe(`cus_${orgId.replaceAll('-', '')}`)
    expect(second.id).toBe(first.id)
  })
})
