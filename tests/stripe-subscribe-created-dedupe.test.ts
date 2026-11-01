import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { executeSQL, USER_PASSWORD_HASH } from './test-utils.ts'

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-subscribe-dedupe-test' : undefined,
    req: { header: () => undefined },
  } as any
}

describe('Stripe webhook replay dedupe (same event.id)', () => {
  const orgId = randomUUID()
  const customerId = `cus_subscribe_replay_${orgId.slice(0, 8)}`
  const ownerId = randomUUID()
  const eventOccurredAt = '2026-11-01T12:00:00.000Z'
  const email = `stripe_subscribe_replay_${orgId.slice(0, 8)}@capgo.app`

  beforeEach(async () => {
    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, email, USER_PASSWORD_HASH],
    )
    await executeSQL(
      `INSERT INTO public.users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, email],
    )
    await executeSQL(
      `INSERT INTO public.stripe_info (customer_id, status, product_id, subscription_id, billing_account)
       VALUES ($1, 'updated', (SELECT stripe_id FROM public.plans WHERE name = 'Solo' LIMIT 1), $2, 'ee')
       ON CONFLICT (customer_id) DO UPDATE SET
         status = EXCLUDED.status,
         product_id = EXCLUDED.product_id,
         subscription_id = EXCLUDED.subscription_id`,
      [customerId, `sub_${orgId.slice(0, 8)}`],
    )
    await executeSQL(
      `INSERT INTO public.orgs (id, name, created_by, management_email, customer_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [orgId, 'Subscribe replay org', ownerId, 'billing-replay@example.com', customerId],
    )
  })

  afterEach(async () => {
    await executeSQL('DELETE FROM public.processed_stripe_events WHERE customer_id = $1', [customerId])
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
    await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
    await executeSQL('DELETE FROM public.users WHERE id = $1', [ownerId])
    await executeSQL('DELETE FROM auth.users WHERE id = $1', [ownerId])
  })

  it('marks a replayed Stripe event id as duplicate so subscribe tracking is skipped', async () => {
    expect(stripeEventTestUtils.shouldSendSubscriptionSubscribeTrackingAfterPersist('duplicate')).toBe(false)

    const stripeEventId = `evt_replay_${orgId.slice(0, 8)}`
    const updateData = { status: 'created' as const }
    const movement = stripeEventTestUtils.classifyRevenueMovement(
      { status: 'updated', paid_at: null, price_id: null, product_id: null, is_good_plan: false },
      updateData,
      await loadRevenuePlans() as Parameters<typeof stripeEventTestUtils.classifyRevenueMovement>[2],
    )

    const first = await stripeEventTestUtils.persistStripeInfoAndRevenueMovement(
      createContext(),
      customerId,
      stripeEventId,
      updateData,
      eventOccurredAt,
      movement,
    )
    const replay = await stripeEventTestUtils.persistStripeInfoAndRevenueMovement(
      createContext(),
      customerId,
      stripeEventId,
      updateData,
      eventOccurredAt,
      movement,
    )

    expect(first.status).toBe('applied')
    expect(replay.status).toBe('duplicate')
  })
})

async function loadRevenuePlans() {
  return executeSQL(
    `SELECT name, stripe_id, stripe_id_us, price_m, price_y, price_m_id, price_y_id,
            price_m_id_us, price_y_id_us, alt_price_m_ids, alt_price_y_ids, regional_price_ids
     FROM public.plans
     WHERE name = ANY($1::varchar[])`,
    [['Solo', 'Maker', 'Team', 'Enterprise']],
  )
}
