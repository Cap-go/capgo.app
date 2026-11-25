import type { Context } from 'hono'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPostgresClient, USER_ID } from './test-utils.ts'

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
const { acceptCancelSaveOffer, declineCancelSaveOffer, prepareCancelSaveOffer } = await import('../supabase/functions/_backend/utils/cancel_save_offer.ts')

const customerId = `cus_${randomUUID()}`
// A dedicated org: the grant flips its has_usage_credits flag, which must not
// touch the seeded orgs other suites read in parallel.
const orgId = randomUUID()
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
let offerA: string
let offerB: string
let discountOffer: string
const discountCustomer = `cus_${randomUUID()}`
// Without credits, so preparing an offer reaches the stale cleanup.
const staleOrgId = randomUUID()

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
  await pool.query(
    `INSERT INTO public.stripe_info (customer_id, status, product_id)
     SELECT $1, 'succeeded', stripe_id FROM public.plans ORDER BY price_m LIMIT 1`,
    [customerId],
  )
  await pool.query(
    `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id, has_usage_credits)
     VALUES ($1::uuid, $2::uuid, 'Cancel Credits Test Org', 'cancel-credits@example.com', $3, false)`,
    [orgId, USER_ID, customerId],
  )
  await pool.query(
    `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id, has_usage_credits)
     VALUES ($1::uuid, $2::uuid, 'Cancel Stale Test Org', 'cancel-stale@example.com', NULL, false)`,
    [staleOrgId, USER_ID],
  )
  // Two offers shown to the same customer (for example two open dialogs).
  const insert = () => pool.query<{ id: string }>(
    `INSERT INTO public.cancel_save_offers
       (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type, credits)
     VALUES ($1, $2, $3, 'ee', 'unused', 1400, 'usd', 'credits', 14) RETURNING id::text`,
    [orgId, customerId, SUBSCRIPTION_ID],
  )
  offerA = (await insert()).rows[0].id
  offerB = (await insert()).rows[0].id
  // A discount accept still running (or whose recording failed): reserved, no discount_start yet.
  discountOffer = (await pool.query<{ id: string }>(
    `INSERT INTO public.cancel_save_offers
       (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, coupon_id, percent_off, duration_months, outcome, responded_at)
     VALUES ($1, $2, 'sub_discount_test', 'ee', 'too_expensive', 1400, 'usd', 'capgo_cancel_save_50_3m', 50, 3, 'accepting', now()) RETURNING id::text`,
    [orgId, discountCustomer],
  )).rows[0].id
})

afterAll(async () => {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT credit_grant_id::text AS id FROM public.cancel_save_offers WHERE customer_id = $1 AND credit_grant_id IS NOT NULL`,
    [customerId],
  )
  await pool.query('DELETE FROM public.cancel_save_offers WHERE customer_id = ANY($1)', [[customerId, discountCustomer]])
  for (const { id } of rows) {
    await pool.query('DELETE FROM public.usage_credit_transactions WHERE grant_id = $1', [id])
    await pool.query('DELETE FROM public.usage_credit_grants WHERE id = $1', [id])
  }
  await pool.query('DELETE FROM public.usage_credit_transactions WHERE org_id = $1::uuid', [orgId])
  await pool.query('DELETE FROM public.usage_credit_grants WHERE org_id = $1::uuid', [orgId])
  await pool.query('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [[orgId, staleOrgId]])
  await pool.query('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
  await pool.end()
})

describe('credits offer accept after a failed cancellation', () => {
  it('keeps one grant reserved, rejects a second offer, and finishes on retry', async () => {
    // 1. The grant commits, then Stripe fails: the offer stays reserved with its grant.
    mocks.cancel.mockRejectedValueOnce(new Error('stripe unavailable'))
    await expect(acceptCancelSaveOffer(c, ctx, offerA, 'only one app')).rejects.toThrow('stripe unavailable')
    expect(await grantCount()).toBe(1)
    const reserved = await offer(offerA)
    expect(reserved.outcome).toBe('accepting')
    expect(reserved.credit_grant_id).not.toBeNull()

    // 2. Another offer of the same customer cannot reserve or grant again.
    await expect(acceptCancelSaveOffer(c, ctx, offerB)).rejects.toThrow('no longer available')
    expect(await grantCount()).toBe(1)
    expect((await offer(offerB)).outcome).toBe('offered')

    // 3. The retry reuses the grant and cancels the subscription the offer checked.
    mocks.cancel.mockResolvedValueOnce(null)
    await expect(acceptCancelSaveOffer(c, ctx, offerA, 'only one app')).resolves.toEqual({ type: 'credits', credits: 14 })
    expect(mocks.cancel).toHaveBeenLastCalledWith(c, ctx, 'unused', 'only one app', SUBSCRIPTION_ID)
    expect(await grantCount()).toBe(1)
    expect(await offer(offerA)).toEqual({ outcome: 'accepted', credit_grant_id: reserved.credit_grant_id })

    // 4. Replaying the accepted offer returns the result without canceling again.
    const cancels = mocks.cancel.mock.calls.length
    await expect(acceptCancelSaveOffer(c, ctx, offerA)).resolves.toEqual({ type: 'credits', credits: 14 })
    expect(mocks.cancel.mock.calls.length).toBe(cancels)
    expect(await grantCount()).toBe(1)
  })
})

describe('declining a discount offer while its accept is in flight', () => {
  const discountCtx = (discounts: unknown[] | Error) => ({
    customerId: discountCustomer,
    billingAccount: 'ee',
    publishableKey: '',
    stripe: { subscriptions: { retrieve: async () => {
      if (discounts instanceof Error)
        throw discounts
      return { discounts }
    } } },
  }) as any

  it('keeps the reservation whatever Stripe shows: the accept may still be applying it', async () => {
    await declineCancelSaveOffer(c, discountCtx([{ start: 1, source: { coupon: 'capgo_cancel_save_50_3m' } }]), discountOffer)
    expect((await offer(discountOffer)).outcome).toBe('accepting')
    await declineCancelSaveOffer(c, discountCtx([]), discountOffer)
    expect((await offer(discountOffer)).outcome).toBe('accepting')
  })


  it('keeps a discount reservation on a changed subscription while Stripe shows its discount', async () => {
    // The active subscription is not the offer's: the accept stops, but the discount an
    // earlier attempt applied keeps the save reserved.
    await expect(acceptCancelSaveOffer(c, discountCtx([{ start: 1, source: { coupon: 'capgo_cancel_save_50_3m' } }]), discountOffer)).rejects.toThrow('no longer available')
    expect((await offer(discountOffer)).outcome).toBe('accepting')
    await expect(acceptCancelSaveOffer(c, discountCtx(new Error('stripe down')), discountOffer)).rejects.toThrow('no longer available')
    expect((await offer(discountOffer)).outcome).toBe('accepting')
    await expect(acceptCancelSaveOffer(c, discountCtx([]), discountOffer)).rejects.toThrow('no longer available')
    expect((await offer(discountOffer)).outcome).toBe('offered')
  })

  it('reconciles a stale reservation of another subscription with Stripe', async () => {
    await pool.query(`UPDATE public.cancel_save_offers SET outcome = 'accepting', responded_at = now() - interval '1 hour' WHERE id = $1`, [discountOffer])
    // The current subscription is saveable; the offer's old one answers as given.
    const prepareCtx = (old: unknown[] | Error) => ({
      ...discountCtx([]),
      stripe: { subscriptions: { retrieve: async (id: string) => {
        if (id !== 'sub_discount_test')
          return ctx.stripe.subscriptions.retrieve()
        if (old instanceof Error)
          throw old
        return { discounts: old }
      } } },
    }) as any
    // Unreadable: kept. No discount there: freed.
    await prepareCancelSaveOffer(c, prepareCtx(new Error('stripe down')), staleOrgId, 'too_expensive')
    expect((await offer(discountOffer)).outcome).toBe('accepting')
    await prepareCancelSaveOffer(c, prepareCtx([]), staleOrgId, 'too_expensive')
    expect((await offer(discountOffer)).outcome).not.toBe('accepting')
    // Discount found there: recorded as accepted with its dates.
    await pool.query(`UPDATE public.cancel_save_offers SET outcome = 'accepting', responded_at = now() - interval '1 hour' WHERE id = $1`, [discountOffer])
    await pool.query(`DELETE FROM public.cancel_save_offers WHERE customer_id = $1 AND id <> $2`, [discountCustomer, discountOffer])
    await prepareCancelSaveOffer(c, prepareCtx([{ start: 1767225600, end: 1775001600, source: { coupon: 'capgo_cancel_save_50_3m' } }]), staleOrgId, 'too_expensive')
    const { rows } = await pool.query<{ outcome: string, discount_end: Date }>('SELECT outcome, discount_end FROM public.cancel_save_offers WHERE id = $1', [discountOffer])
    expect(rows[0].outcome).toBe('accepted')
    expect(rows[0].discount_end.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })
})

describe('cancel attempts recorded for the admin report', () => {
  it('records the attempt, a founder call click, and the cancel, scoped to the org', async () => {
    const { recordCancelAttempt, recordCancelAttemptCanceled, recordFounderCallClick } = await import('../supabase/functions/_backend/utils/cancel_attempt.ts')
    const id = await recordCancelAttempt(c, { orgId, customerId, reason: 'missing_features', offerId: null, founderCall: true })
    expect(id).not.toBeNull()
    // Another org cannot touch it.
    await recordFounderCallClick(c, staleOrgId, id!)
    await recordCancelAttemptCanceled(c, staleOrgId, id!)
    const read = async () => (await pool.query<{ reason: string, founder_call_shown: boolean, founder_call_clicked_at: Date | null, canceled_at: Date | null }>(
      'SELECT reason, founder_call_shown, founder_call_clicked_at, canceled_at FROM public.cancel_attempts WHERE id = $1',
      [id],
    )).rows[0]
    expect(await read()).toMatchObject({ reason: 'missing_features', founder_call_shown: true, founder_call_clicked_at: null, canceled_at: null })
    await recordFounderCallClick(c, orgId, id!)
    await recordCancelAttemptCanceled(c, orgId, id!)
    const done = await read()
    expect(done.founder_call_clicked_at).not.toBeNull()
    expect(done.canceled_at).not.toBeNull()
  })

  it('never counts a click on an attempt that did not show the founder call', async () => {
    const { recordCancelAttempt, recordFounderCallClick } = await import('../supabase/functions/_backend/utils/cancel_attempt.ts')
    const id = await recordCancelAttempt(c, { orgId, customerId, reason: 'too_expensive', offerId: null, founderCall: false })
    await recordFounderCallClick(c, orgId, id!)
    const { rows } = await pool.query('SELECT founder_call_clicked_at FROM public.cancel_attempts WHERE id = $1', [id])
    expect(rows[0].founder_call_clicked_at).toBeNull()
  })
})
