import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

const {
  notifToOrgMembersMock,
  notifToOrgMembersOnceWithResultMock,
  syncBillingBentoTagsMock,
  purgeOnPremCacheMock,
  purgePlanCacheMock,
  sendEventToTrackingMock,
  pgClientQuery,
} = vi.hoisted(() => ({
  notifToOrgMembersMock: vi.fn(),
  notifToOrgMembersOnceWithResultMock: vi.fn(),
  syncBillingBentoTagsMock: vi.fn(),
  purgeOnPremCacheMock: vi.fn(),
  purgePlanCacheMock: vi.fn(),
  sendEventToTrackingMock: vi.fn(),
  pgClientQuery: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: () => true,
  syncBentoSubscriberTags: syncBillingBentoTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: vi.fn(async () => ({ query: pgClientQuery })),
  closeClient: vi.fn(),
  checkoutPgClient: vi.fn(async () => ({ query: pgClientQuery })),
  beginWriteTransaction: vi.fn(async () => {}),
  releasePgClient: vi.fn(),
  withAdminPg: vi.fn(async (_c: unknown, fn: (pg: { query: typeof pgClientQuery }) => unknown) => fn({ query: pgClientQuery })),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: async (_c: unknown, promise: Promise<unknown>) => promise,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/org_email_notifications.ts')>(),
  sendNotifToOrgMembers: notifToOrgMembersMock,
  sendNotifToOrgMembersOnceWithResult: notifToOrgMembersOnceWithResultMock,
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  trackPosthogEvent: vi.fn(async () => true),
  deliverPosthogEvent: vi.fn(async () => ({ outcome: 'delivered', legacy_success: true })),
  groupIdentifyPosthog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
  cloudlog: vi.fn(),
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/tracking.ts')>()
  return {
    ...actual,
    sendEventToTracking: sendEventToTrackingMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/cloudflare_cache_purge.ts', () => ({
  purgeOnPremCacheForOrg: purgeOnPremCacheMock,
  purgePlanCacheForOrg: purgePlanCacheMock,
}))

const checkPlanStatusOnlyMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/plans.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/plans.ts')>()
  return {
    ...mod,
    checkPlanStatusOnly: checkPlanStatusOnlyMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe_billing.ts')>()
  const soloPlan = {
    name: 'Solo',
    stripe_id: 'prod_solo',
    stripe_id_us: null,
    price_m: 15,
    price_y: 150,
    price_m_id: 'price_solo_m',
    price_y_id: 'price_solo_y',
    price_m_id_us: null,
    price_y_id_us: null,
    alt_price_m_ids: [],
    alt_price_y_ids: [],
    regional_price_ids: null,
  }
  return {
    ...mod,
    queryPlanByProductId: vi.fn(async () => soloPlan),
  }
})

vi.mock('../supabase/functions/_backend/utils/supabase.ts', async importOriginal => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/supabase.ts')>()
  return {
    ...mod,
    customerToSegmentOrg: vi.fn(async () => ({ segments: ['plan-solo'], deleteSegments: [] })),
  }
})

const SOLO_PLAN = {
  name: 'Solo',
  stripe_id: 'prod_solo',
  stripe_id_us: null,
  price_m: 15,
  price_y: 150,
  price_m_id: 'price_solo_m',
  price_y_id: 'price_solo_y',
  price_m_id_us: null,
  price_y_id_us: null,
  alt_price_m_ids: [],
  alt_price_y_ids: [],
  regional_price_ids: null,
}

const { createdOrUpdated, resolveActiveSubscriptionStatus } = stripeEventTestUtils

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-subscribe-dedupe-test' : undefined,
    req: { header: () => undefined },
  } as any
}

function setupPgMockForCreatedOrUpdated(options?: { processedStripeEventInserts?: number }) {
  let processedEventClaimed = false
  pgClientQuery.mockImplementation(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (sql.includes('pg_catalog.to_json'))
      return { rows: [{ row: SOLO_PLAN }] }
    if (normalized.includes('SELECT last_stripe_event_at'))
      return { rows: [{ last_stripe_event_at: null, past_due_at: null, status: 'updated', paid_at: null }], rowCount: 1 }
    if (normalized.includes('INSERT INTO public.processed_stripe_events')) {
      if (options?.processedStripeEventInserts === 0 || processedEventClaimed)
        return { rowCount: 0 }
      processedEventClaimed = true
      return { rowCount: 1 }
    }
    if (normalized.includes('UPDATE public.stripe_info'))
      return { rowCount: 1 }
    if (normalized.includes('DELETE FROM public.processed_stripe_events'))
      return { rowCount: 1 }
    if (normalized === 'ROLLBACK' || normalized === 'COMMIT' || normalized === 'BEGIN')
      return { rowCount: 0 }
    return { rows: [], rowCount: 0 }
  })
}

function makeCreatedWebhookContext(stripeEventId: string) {
  const variables = new Map<string, unknown>([
    ['requestId', 'stripe-subscribe-created-order'],
    ['stripeEvent', { id: stripeEventId, type: 'customer.subscription.created' }],
  ])
  return {
    env: { SUPABASE_DB_URL: 'postgresql://unit.test/db' },
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => variables.set(key, value),
    req: { header: () => undefined, raw: { headers: new Headers() } },
    res: { headers: new Headers() },
  } as any
}

describe('subscription subscribe_created Bento dedupe', () => {
  it.concurrent('uses once-ever Bento delivery for created subscribe events', () => {
    const metadata = { plan_name: 'Solo', plan_type: 'monthly' }
    expect(stripeEventTestUtils.buildSubscriptionSubscribeBentoPayload(
      'created',
      'user:subscribe_created:monthly',
      'Solo',
      metadata,
    )).toEqual({
      once: true,
      audience: 'billing',
      data: metadata,
      event: 'user:subscribe_created:monthly',
      preferenceKey: 'credit_usage',
      uniqId: 'subscription:user:subscribe_created:monthly:Solo',
    })
  })

  it.concurrent('records processed Stripe events for subscription stripe_info writes without revenue movement', () => {
    const updateStatement = { text: 'UPDATE public.stripe_info SET status = $2 WHERE customer_id = $1', values: ['cus_x', 'created'] }
    expect(stripeEventTestUtils.shouldRecordProcessedStripeEvent(
      updateStatement,
      stripeEventTestUtils.classifyRevenueMovement(
        { status: 'updated', paid_at: null, price_id: null, product_id: null, is_good_plan: false },
        { status: 'created' },
        [],
      ),
    )).toBe(true)
  })

  it.concurrent('keeps cron throttling for updated and succeeded subscribe events', () => {
    const metadata = { plan_name: 'Solo', plan_type: 'monthly' }
    expect(stripeEventTestUtils.buildSubscriptionSubscribeBentoPayload(
      'updated',
      'user:subscribe_updated:monthly',
      'Solo',
      metadata,
    )).toEqual({
      cron: '* * * * *',
      audience: 'billing',
      data: metadata,
      event: 'user:subscribe_updated:monthly',
      preferenceKey: 'credit_usage',
      uniqId: 'subscription:user:subscribe_updated:monthly:Solo',
    })
  })

  it('syncs billing Bento tags before subscribe tracking on created subscriptions', async () => {
    const callOrder: string[] = []
    syncBillingBentoTagsMock.mockReset()
    syncBillingBentoTagsMock.mockImplementation(async () => {
      callOrder.push('syncBillingBentoTags')
    })
    sendEventToTrackingMock.mockReset()
    sendEventToTrackingMock.mockImplementation(async (_c, payload) => {
      if (payload.event === 'User subscribe')
        callOrder.push('subscribeTracking')
    })
    setupPgMockForCreatedOrUpdated({ processedStripeEventInserts: 1 })

    const orgId = randomUUID()
    const stripeData = {
      data: {
        customer_id: 'cus_created_order',
        product_id: SOLO_PLAN.stripe_id,
        price_id: SOLO_PLAN.price_m_id,
        status: 'created',
        subscription_id: 'sub_created_order',
      },
      previousProductId: null,
      previousPriceId: null,
      isUpgrade: false,
    }
    resolveActiveSubscriptionStatus(
      stripeData.data.status,
      { status: 'updated' } as any,
      stripeData.data.subscription_id,
      'paid',
    )

    await createdOrUpdated(
      makeCreatedWebhookContext('evt_created_order'),
      stripeData as any,
      { id: orgId, name: 'Created order org', management_email: 'billing-order@example.com' } as any,
      {
        customer_id: stripeData.data.customer_id,
        product_id: SOLO_PLAN.stripe_id,
        price_id: SOLO_PLAN.price_m_id,
        status: 'updated',
        last_stripe_event_at: null,
      } as any,
      new Date().toISOString(),
      'created',
    )

    const syncIndex = callOrder.indexOf('syncBillingBentoTags')
    const subscribeIndex = callOrder.indexOf('subscribeTracking')
    expect(syncIndex).toBeGreaterThanOrEqual(0)
    expect(subscribeIndex).toBeGreaterThan(syncIndex)
    expect(sendEventToTrackingMock).toHaveBeenCalled()
  })

  it('releases the Stripe event ledger when subscribe tracking fails after a successful persist', async () => {
    sendEventToTrackingMock.mockReset()
    sendEventToTrackingMock.mockRejectedValueOnce(new Error('subscribe tracking failed'))
    syncBillingBentoTagsMock.mockReset()
    syncBillingBentoTagsMock.mockResolvedValue(undefined)

    let releaseLedger = false
    pgClientQuery.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (sql.includes('pg_catalog.to_json'))
        return { rows: [{ row: SOLO_PLAN }] }
      if (normalized.includes('SELECT last_stripe_event_at'))
        return { rows: [{ last_stripe_event_at: null, past_due_at: null, status: 'updated', paid_at: null }], rowCount: 1 }
      if (normalized.includes('INSERT INTO public.processed_stripe_events'))
        return { rowCount: 1 }
      if (normalized.includes('DELETE FROM public.processed_stripe_events')) {
        releaseLedger = true
        return { rowCount: 1 }
      }
      if (normalized.includes('UPDATE public.stripe_info'))
        return { rowCount: 1 }
      if (normalized === 'ROLLBACK' || normalized === 'COMMIT' || normalized === 'BEGIN')
        return { rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })

    const orgId = randomUUID()
    await expect(createdOrUpdated(
      makeCreatedWebhookContext('evt_release_ledger'),
      {
        data: {
          customer_id: 'cus_release_ledger',
          product_id: SOLO_PLAN.stripe_id,
          price_id: SOLO_PLAN.price_m_id,
          status: 'created',
          subscription_id: 'sub_release',
        },
        previousProductId: null,
        previousPriceId: null,
        isUpgrade: false,
      } as any,
      { id: orgId, name: 'Release ledger org', management_email: 'billing-release@example.com' } as any,
      {
        customer_id: 'cus_release_ledger',
        product_id: SOLO_PLAN.stripe_id,
        price_id: SOLO_PLAN.price_m_id,
        status: 'updated',
        last_stripe_event_at: null,
      } as any,
      new Date().toISOString(),
      'created',
    )).rejects.toThrow('subscribe tracking failed')

    expect(releaseLedger).toBe(true)
  })

  it('runs subscribe tracking once when the same event.id is delivered concurrently', async () => {
    sendEventToTrackingMock.mockReset()
    sendEventToTrackingMock.mockResolvedValue(undefined)
    syncBillingBentoTagsMock.mockReset()
    syncBillingBentoTagsMock.mockResolvedValue(undefined)
    purgeOnPremCacheMock.mockResolvedValue(undefined)
    purgePlanCacheMock.mockResolvedValue(undefined)

    let ledgerClaimed = false
    pgClientQuery.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (sql.includes('pg_catalog.to_json'))
        return { rows: [{ row: SOLO_PLAN }] }
      if (normalized.includes('name = ANY'))
        return { rows: [SOLO_PLAN].map(row => ({ row })) }
      if (normalized.includes('SELECT last_stripe_event_at'))
        return { rows: [{ last_stripe_event_at: null, past_due_at: null, status: 'updated', paid_at: null }], rowCount: 1 }
      if (normalized.includes('INSERT INTO public.processed_stripe_events')) {
        if (ledgerClaimed)
          return { rowCount: 0 }
        ledgerClaimed = true
        return { rowCount: 1 }
      }
      if (normalized.includes('UPDATE public.stripe_info'))
        return { rowCount: 1 }
      if (normalized === 'ROLLBACK' || normalized === 'COMMIT' || normalized === 'BEGIN')
        return { rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })

    const orgId = randomUUID()
    const stripeEventId = 'evt_concurrent_subscribe'
    const stripeData = {
      data: {
        customer_id: 'cus_concurrent_subscribe',
        product_id: SOLO_PLAN.stripe_id,
        price_id: SOLO_PLAN.price_m_id,
        status: 'created',
        subscription_id: 'sub_concurrent',
      },
      previousProductId: null,
      previousPriceId: null,
      isUpgrade: false,
    }
    const currentStripeInfo = {
      customer_id: stripeData.data.customer_id,
      product_id: SOLO_PLAN.stripe_id,
      price_id: SOLO_PLAN.price_m_id,
      status: 'updated',
      last_stripe_event_at: null,
    }
  const eventOccurredAt = new Date().toISOString()

    await Promise.all([
      createdOrUpdated(
        makeCreatedWebhookContext(stripeEventId),
        stripeData as any,
        { id: orgId, name: 'Concurrent org' } as any,
        currentStripeInfo as any,
        eventOccurredAt,
        'created',
      ),
      createdOrUpdated(
        makeCreatedWebhookContext(stripeEventId),
        stripeData as any,
        { id: orgId, name: 'Concurrent org' } as any,
        currentStripeInfo as any,
        eventOccurredAt,
        'created',
      ),
    ])

    const subscribeTrackingCalls = sendEventToTrackingMock.mock.calls.filter(
      call => call[1]?.event === 'User subscribe',
    )
    expect(subscribeTrackingCalls).toHaveLength(1)
  })
})

describe('second created subscription event for the same org', () => {
  const orgId = randomUUID()

  beforeEach(() => {
    notifToOrgMembersMock.mockReset()
    notifToOrgMembersOnceWithResultMock.mockReset()
    notifToOrgMembersOnceWithResultMock.mockResolvedValue('sent')
    notifToOrgMembersMock.mockResolvedValue(true)
  })

  it('delivers subscribe_created Bento at most once per org across a second created webhook', async () => {
    const { sendEventToTracking } = await vi.importActual<typeof import('../supabase/functions/_backend/utils/tracking.ts')>('../supabase/functions/_backend/utils/tracking.ts')
    const metadata = { plan_name: 'Solo', plan_type: 'monthly' }
    const payload = {
      bento: stripeEventTestUtils.buildSubscriptionSubscribeBentoPayload(
        'created',
        'user:subscribe_created:monthly',
        'Solo',
        metadata,
      ),
      channel: 'usage',
      event: 'User subscribe',
      sentToBento: true,
      user_id: orgId,
      groups: { organization: orgId },
      tags: metadata,
    }

    await sendEventToTracking(createContext(), payload, { background: false })
    notifToOrgMembersOnceWithResultMock.mockResolvedValueOnce('already_claimed')
    await sendEventToTracking(createContext(), payload, { background: false })

    expect(notifToOrgMembersOnceWithResultMock).toHaveBeenCalledTimes(2)
    expect(notifToOrgMembersMock).not.toHaveBeenCalled()
    expect(notifToOrgMembersOnceWithResultMock.mock.calls.every(call => call[5] === payload.bento!.uniqId)).toBe(true)
  })
})

describe('webhook replay blocks subscribe tracking before Bento', () => {
  it.concurrent('does not send subscribe tracking when persist returns duplicate', () => {
    expect(stripeEventTestUtils.shouldSendSubscriptionSubscribeTrackingAfterPersist('duplicate')).toBe(false)
    expect(stripeEventTestUtils.shouldSendSubscriptionSubscribeTrackingAfterPersist('applied')).toBe(true)
  })
})