import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHECKOUT_SESSION_LOOKBACK_SECONDS, resolveCheckoutSession } from '../supabase/functions/_backend/private/credits.ts'

const ORG_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = 'cus_123'

const mocks = vi.hoisted(() => ({
  queries: [] as { text: string, values: unknown[] }[],
  processedRows: [] as { session_id: string | null, payment_intent_id: string | null }[],
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>(),
  withRlsTransaction: async (_pg: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => run({}),
  queryJson: async (_client: unknown, text: string, values: unknown[] = []) => {
    mocks.queries.push({ text, values })
    return mocks.processedRows
  },
}))

function session(id: string, created: number, overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id,
    created,
    customer: CUSTOMER_ID,
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    client_reference_id: ORG_ID,
    metadata: {},
    payment_intent: `pi_${id}`,
    ...overrides,
  } as Stripe.Checkout.Session
}

function fakeStripe(pages: Stripe.Checkout.Session[][]) {
  const list = vi.fn(async () => {
    const data = pages.shift() ?? []
    return { data, has_more: pages.length > 0 }
  })
  return { stripe: { checkout: { sessions: { list, retrieve: vi.fn() } } } as any, list }
}

const db = { pg: {} as any, principal: { kind: 'service' } as any }
const c = { env: {}, get: () => undefined } as any

beforeEach(() => {
  mocks.queries.length = 0
  mocks.processedRows = []
})

describe('resolveCheckoutSession without sessionId', () => {
  it('bounds the Stripe listing to the lookback window', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { stripe, list } = fakeStripe([[session('cs_test_a', now)]])
    await resolveCheckoutSession(c, stripe, db, ORG_ID, CUSTOMER_ID)
    const params = (list.mock.calls[0] as unknown as [{ created?: { gte: number } }])[0]
    expect(params.created?.gte).toBeGreaterThanOrEqual(now - CHECKOUT_SESSION_LOOKBACK_SECONDS - 5)
    expect(params.created?.gte).toBeLessThanOrEqual(now - CHECKOUT_SESSION_LOOKBACK_SECONDS + 5)
  })

  it('checks every candidate session with a single processed-top-up query', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { stripe, list } = fakeStripe([
      [session('cs_test_a', now - 10), session('cs_test_b', now - 20)],
      [session('cs_test_c', now - 30, { payment_intent: null }), session('cs_test_other', now, { client_reference_id: 'other', metadata: {} })],
    ])
    mocks.processedRows = [
      { session_id: 'cs_test_a', payment_intent_id: 'pi_cs_test_a' },
      { session_id: 'cs_test_elsewhere', payment_intent_id: 'pi_cs_test_b' },
    ]
    const resolved = await resolveCheckoutSession(c, stripe, db, ORG_ID, CUSTOMER_ID)
    expect(resolved.id).toBe('cs_test_c')
    expect(list).toHaveBeenCalledTimes(2)
    expect(mocks.queries).toHaveLength(1)
    expect(mocks.queries[0].text).toContain('= ANY($2::text[])')
    expect(mocks.queries[0].values).toEqual([
      ORG_ID,
      ['cs_test_a', 'cs_test_b', 'cs_test_c'],
      ['pi_cs_test_a', 'pi_cs_test_b'],
    ])
  })

  it('still refuses to guess between several unprocessed sessions', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { stripe } = fakeStripe([[session('cs_test_a', now - 10), session('cs_test_b', now - 20)]])
    await expect(resolveCheckoutSession(c, stripe, db, ORG_ID, CUSTOMER_ID)).rejects.toThrow('Multiple completed checkout sessions')
  })

  it('reports session_not_found without querying when there is no candidate', async () => {
    const { stripe } = fakeStripe([[]])
    await expect(resolveCheckoutSession(c, stripe, db, ORG_ID, CUSTOMER_ID)).rejects.toThrow('No completed checkout session found')
    expect(mocks.queries).toHaveLength(0)
  })
})
