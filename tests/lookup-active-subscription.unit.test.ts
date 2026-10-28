import { afterEach, describe, expect, it, vi } from 'vitest'

// Answers the stripe_info lookup from a supabase-js style `{ data, error }` result.
function mockStripeInfo(result: { data: unknown, error: unknown }) {
  return (async (_c: unknown, _principal: unknown, run: (client: any) => Promise<unknown>) => run({
    query: async (text: string) => {
      expect(text).toContain('FROM public.stripe_info')
      if (result.error)
        throw result.error
      return { rows: result.data ? [result.data] : [] }
    },
  })) as any
}

describe('lookupActiveSubscriptionId', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks known false when stripe_info read fails', async () => {
    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')
    const stripeModule = await import('../supabase/functions/_backend/utils/stripe.ts')
    const spy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementation(mockStripeInfo({
      data: null,
      error: { message: 'connection refused' },
    }))

    try {
      const result = await stripeModule.lookupActiveSubscriptionId({ get: () => 'request-id' } as any, 'cus_123')
      expect(result).toEqual({ subscriptionId: null, known: false })
    }
    finally {
      spy.mockRestore()
    }
  })

  it('marks known true when there is no active subscription row', async () => {
    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')
    const stripeModule = await import('../supabase/functions/_backend/utils/stripe.ts')
    const spy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementation(mockStripeInfo({ data: null, error: null }))

    try {
      const result = await stripeModule.lookupActiveSubscriptionId({ get: () => 'request-id' } as any, 'cus_123')
      expect(result).toEqual({ subscriptionId: null, known: true })
    }
    finally {
      spy.mockRestore()
    }
  })

  it('returns the active subscription id when the row is live', async () => {
    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')
    const stripeModule = await import('../supabase/functions/_backend/utils/stripe.ts')
    const spy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementation(mockStripeInfo({
      data: { subscription_id: 'sub_live', status: 'active' },
      error: null,
    }))

    try {
      const result = await stripeModule.lookupActiveSubscriptionId({ get: () => 'request-id' } as any, 'cus_123')
      expect(result).toEqual({ subscriptionId: 'sub_live', known: true })
    }
    finally {
      spy.mockRestore()
    }
  })

  it.each(['canceled', 'deleted'] as const)('marks known true with no id when status is %s', async (status) => {
    const pgRlsModule = await import('../supabase/functions/_backend/utils/pg_rls.ts')
    const stripeModule = await import('../supabase/functions/_backend/utils/stripe.ts')
    const spy = vi.spyOn(pgRlsModule, 'withRlsContext').mockImplementation(mockStripeInfo({
      data: { subscription_id: 'sub_old', status },
      error: null,
    }))

    try {
      const result = await stripeModule.lookupActiveSubscriptionId({ get: () => 'request-id' } as any, 'cus_123')
      expect(result).toEqual({ subscriptionId: null, known: true })
    }
    finally {
      spy.mockRestore()
    }
  })
})
