import type { Context } from 'hono'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPostgresClient } from './test-utils.ts'

// Accepting a credits offer against real Postgres, with Stripe mocked: when the
// cancellation fails after the grant committed, the offer stays reserved, another
// offer of the same customer cannot grant again, and a retry reuses the grant.
const mocks = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  cancel: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: async () => mocks.pool,
  closeClient: () => {},
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  getActiveSubscriptionId: async () => SUBSCRIPTION_ID,
  lookupActiveSubscriptionId: async () => ({ subscriptionId: SUBSCRIPTION_ID, known: true }),
  syncSubscriptionData: async () => {},
}))
vi.mock('../supabase/functions/_backend/utils/stripe_in_app.ts', () => ({
  scheduleSubscriptionCancel: mocks.cancel,
}))

const SUBSCRIPTION_ID = 'sub_cancel_credits_test'
const { acceptCancelSaveOffer } = await import('../supabase/functions/_backend/utils/cancel_save_offer.ts')

const customerId = `cus_${randomUUID()}`
const c = { get: () => 'req_test' } as unknown as Context<any>
// A monthly, active, undiscounted subscription: eligible for a first grant.
const ctx = {
  customerId,
  billingAccount: 'ee',
  publishableKey: '',
  stripe: {
    subscriptions: {
      retrieve: async () => ({
        status: 'active',
        cancel_at_period_end: false,
        cancel_at: null,
        discounts: [],
        currency: 'usd',
        items: { data: [{ quantity: 1, price: { unit_amount: 1400, product: 'prod_solo', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }] },
      }),
    },
  },
} as any

let pool: Pool
let orgId: string
let offerA: string
let offerB: string

async function grantCount() {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.usage_credit_grants WHERE org_id = $1 AND source = 'cancel_save_offer'`,
    [orgId],
  )
  return rows[0].n
}

async function offer(id: string) {
  const { rows } = await pool.query<{ outcome: string, credit_grant_id: string | null }>(
    'SELECT outcome, credit_grant_id::text FROM public.cancel_save_offers WHERE id = $1',
    [id],
  )
  return rows[0]
}

beforeAll(async () => {
  pool = await getPostgresClient()
  mocks.pool = pool
  const { rows: org } = await pool.query<{ id: string }>(
    `SELECT id::text FROM public.orgs WHERE id NOT IN (SELECT org_id FROM public.usage_credit_grants) ORDER BY created_at, id LIMIT 1`,
  )
  orgId = org[0].id
  // Two offers shown to the same customer (for example two open dialogs).
  const insert = () => pool.query<{ id: string }>(
    `INSERT INTO public.cancel_save_offers
       (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type, credits)
     VALUES ($1, $2, $3, 'ee', 'unused', 1400, 'usd', 'credits', 14) RETURNING id::text`,
    [orgId, customerId, SUBSCRIPTION_ID],
  )
  offerA = (await insert()).rows[0].id
  offerB = (await insert()).rows[0].id
})

afterAll(async () => {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT credit_grant_id::text AS id FROM public.cancel_save_offers WHERE customer_id = $1 AND credit_grant_id IS NOT NULL`,
    [customerId],
  )
  await pool.query('DELETE FROM public.cancel_save_offers WHERE customer_id = $1', [customerId])
  for (const { id } of rows) {
    await pool.query('DELETE FROM public.usage_credit_transactions WHERE grant_id = $1', [id])
    await pool.query('DELETE FROM public.usage_credit_grants WHERE id = $1', [id])
  }
  await pool.end()
})

describe('credits offer accept after a failed cancellation', () => {
  it('keeps the reservation and the single grant when Stripe fails after the grant', async () => {
    mocks.cancel.mockRejectedValueOnce(new Error('stripe unavailable'))
    await expect(acceptCancelSaveOffer(c, ctx, offerA, 'only one app')).rejects.toThrow('stripe unavailable')
    expect(await grantCount()).toBe(1)
    const a = await offer(offerA)
    expect(a.outcome).toBe('accepting')
    expect(a.credit_grant_id).not.toBeNull()
  })

  it('rejects another offer of the same customer without granting again', async () => {
    await expect(acceptCancelSaveOffer(c, ctx, offerB)).rejects.toThrow('no longer available')
    expect(await grantCount()).toBe(1)
    expect((await offer(offerB)).outcome).toBe('offered')
  })

  it('finishes on retry with the same grant', async () => {
    const before = (await offer(offerA)).credit_grant_id
    mocks.cancel.mockResolvedValueOnce(null)
    await expect(acceptCancelSaveOffer(c, ctx, offerA, 'only one app')).resolves.toEqual({ type: 'credits', credits: 14 })
    expect(mocks.cancel).toHaveBeenLastCalledWith(c, ctx, 'unused', 'only one app')
    expect(await grantCount()).toBe(1)
    expect(await offer(offerA)).toEqual({ outcome: 'accepted', credit_grant_id: before })
  })
})
