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
    const { createCustomer, localOrgStripeCustomerId } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const orgId = '48cf992a-c9ac-4591-863e-28fdccebdc30'

    const first = await createCustomer(createContext(), 'a@example.com', 'user-1', orgId, 'Lock Media LLC')
    const second = await createCustomer(createContext(), 'a@example.com', 'user-1', orgId, 'Lock Media LLC')

    expect(first.id).toBe(localOrgStripeCustomerId(orgId))
    expect(first.id.startsWith('cus_local_')).toBe(true)
    expect(second.id).toBe(first.id)
  })

  it('recovers the existing customer when Stripe idempotency params change', async () => {
    const orgId = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
    const createCustomerApi = vi.fn().mockRejectedValue({
      type: 'idempotency_error',
      message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
    })
    const searchCustomerApi = vi.fn().mockResolvedValue({
      data: [
        { id: 'cus_newer', created: 200 },
        { id: 'cus_older', created: 100 },
      ],
    })
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        customers: {
          create: createCustomerApi,
          search: searchCustomerApi,
        },
      }
    } as any)

    const { createCustomer } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const customer = await createCustomer(createContext(), 'owner@example.com', 'user-1', orgId, 'WN Hub')

    expect(customer.id).toBe('cus_older')
    expect(searchCustomerApi).toHaveBeenCalledWith({
      query: `metadata['org_id']:'${orgId}'`,
      limit: 10,
    })
  })

  it('falls back to listing by email when Stripe search has not indexed the customer yet', async () => {
    const orgId = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
    const createCustomerApi = vi.fn().mockRejectedValue({
      type: 'idempotency_error',
      message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
    })
    const searchCustomerApi = vi.fn().mockResolvedValue({ data: [] })
    const listCustomerApi = vi.fn().mockResolvedValue({
      data: [
        { id: 'cus_other', created: 50, metadata: { org_id: 'other-org' } },
        { id: 'cus_newer', created: 200, metadata: { org_id: orgId } },
        { id: 'cus_older', created: 100, metadata: { org_id: orgId } },
      ],
    })
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        customers: {
          create: createCustomerApi,
          search: searchCustomerApi,
          list: listCustomerApi,
        },
      }
    } as any)

    const { createCustomer } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const customer = await createCustomer(createContext(), 'owner@example.com', 'user-1', orgId, 'WN Hub')

    expect(customer.id).toBe('cus_older')
    expect(listCustomerApi).toHaveBeenCalledWith({ email: 'owner@example.com', limit: 100 })
  })

  it('retries metadata search when the email list does not include the org customer', async () => {
    const orgId = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
    const createCustomerApi = vi.fn().mockRejectedValue({
      type: 'idempotency_error',
      message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
    })
    const searchCustomerApi = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: 'cus_original', created: 100, metadata: { org_id: orgId } }],
      })
    const listCustomerApi = vi.fn().mockResolvedValue({ data: [] })
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        customers: {
          create: createCustomerApi,
          search: searchCustomerApi,
          list: listCustomerApi,
        },
      }
    } as any)

    const { createCustomer } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const customer = await createCustomer(createContext(), 'new-owner@example.com', 'user-1', orgId, 'WN Hub')

    expect(customer.id).toBe('cus_original')
    expect(searchCustomerApi).toHaveBeenCalledTimes(2)
    expect(listCustomerApi).toHaveBeenCalledWith({ email: 'new-owner@example.com', limit: 100 })
  })

  it('falls back to listing by email when Stripe search rejects', async () => {
    const orgId = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
    const createCustomerApi = vi.fn().mockRejectedValue({
      type: 'idempotency_error',
      message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
    })
    const searchCustomerApi = vi.fn().mockRejectedValue(new Error('search unavailable'))
    const listCustomerApi = vi.fn().mockResolvedValue({
      data: [
        { id: 'cus_listed', created: 100, metadata: { org_id: orgId } },
      ],
    })
    vi.mocked(Stripe).mockImplementation(function () {
      return {
        customers: {
          create: createCustomerApi,
          search: searchCustomerApi,
          list: listCustomerApi,
        },
      }
    } as any)

    const { createCustomer } = await import('../supabase/functions/_backend/utils/stripe.ts')
    const customer = await createCustomer(createContext(), 'owner@example.com', 'user-1', orgId, 'WN Hub')

    expect(customer.id).toBe('cus_listed')
    expect(listCustomerApi).toHaveBeenCalledWith({ email: 'owner@example.com', limit: 100 })
  })
})
