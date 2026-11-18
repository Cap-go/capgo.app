import type Stripe from 'stripe'
import type { StripeData } from '../supabase/functions/_backend/utils/stripe.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const CUSTOMER_ID = 'cus_created_or_updated_fallback'
const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const SUBSCRIPTION_ID = 'sub_created_or_updated_fallback'

const TEAM_PRODUCT_ID = 'prod_team'
const MAKER_PRODUCT_ID = 'prod_maker'
const TEAM_PRICE_ID = 'price_team'
const MAKER_PRICE_ID = 'price_maker'

const TEAM_PLAN = {
  name: 'Team',
  stripe_id: TEAM_PRODUCT_ID,
  stripe_id_us: null,
  price_m: 99,
  price_y: 999,
  price_m_id: TEAM_PRICE_ID,
  price_y_id: 'price_team_y',
  price_m_id_us: null,
  price_y_id_us: null,
  alt_price_m_ids: [],
  alt_price_y_ids: [],
  regional_price_ids: null,
}

const MAKER_PLAN = {
  name: 'Maker',
  stripe_id: MAKER_PRODUCT_ID,
  stripe_id_us: null,
  price_m: 29,
  price_y: 290,
  price_m_id: MAKER_PRICE_ID,
  price_y_id: 'price_maker_y',
  price_m_id_us: null,
  price_y_id_us: null,
  alt_price_m_ids: [],
  alt_price_y_ids: [],
  regional_price_ids: null,
}

const REVENUE_PLANS = [MAKER_PLAN, TEAM_PLAN]

const checkPlanStatusOnly = vi.hoisted(() => vi.fn())
const queueCalls = vi.hoisted(() => [] as unknown[][])
const pgClientQuery = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/plans.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/plans.ts')>()
  return {
    ...mod,
    checkPlanStatusOnly,
  }
})

vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe_billing.ts')>()
  return {
    ...mod,
    queryPlanByProductId: vi.fn(async () => TEAM_PLAN),
  }
})

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  groupIdentifyPosthog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare_cache_purge.ts', () => ({
  purgeOnPremCacheForOrg: vi.fn().mockResolvedValue(undefined),
  purgePlanCacheForOrg: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: vi.fn(() => false),
  syncBentoSubscriberTags: vi.fn().mockResolvedValue(undefined),
  trackBentoEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/supabase.ts')>()
  return {
    ...mod,
    customerToSegmentOrg: vi.fn(async () => ({ plan: 'team' })),
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  const checkoutPgClient = vi.fn(async () => ({ query: pgClientQuery }))
  return {
    ...mod,
    getPgClient: vi.fn(async () => ({ query: pgClientQuery })),
    closeClient: vi.fn(),
    checkoutPgClient,
    beginWriteTransaction: vi.fn(async () => {}),
    releasePgClient: vi.fn(),
    getDrizzleClient: vi.fn(() => ({ execute: vi.fn() })),
  }
})

import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

const { createdOrUpdated, refreshPlanStatusAfterStripeSubscriptionChange, resolveActiveSubscriptionStatus } = stripeEventTestUtils

function makeStripeEvent(): Stripe.CustomerSubscriptionUpdatedEvent {
  return {
    data: {
      object: {
        customer: CUSTOMER_ID,
        id: SUBSCRIPTION_ID,
        items: {
          data: [{
            current_period_end: Math.floor(Date.now() / 1000) + 86_400,
            current_period_start: Math.floor(Date.now() / 1000) - 86_400,
            plan: {
              id: TEAM_PRICE_ID,
              interval: 'month',
              product: TEAM_PRODUCT_ID,
              usage_type: 'licensed',
            },
          }],
        },
        status: 'active',
      },
      previous_attributes: {
        items: {
          data: [{
            current_period_end: Math.floor(Date.now() / 1000) + 86_400,
            current_period_start: Math.floor(Date.now() / 1000) - 86_400,
            plan: {
              id: MAKER_PRICE_ID,
              interval: 'month',
              product: MAKER_PRODUCT_ID,
              usage_type: 'licensed',
            },
          }],
        },
      },
    },
    type: 'customer.subscription.updated',
  } as Stripe.CustomerSubscriptionUpdatedEvent
}

function makeContext(stripeEventId: string) {
  const variables = new Map<string, unknown>([
    ['requestId', 'stripe-plan-refresh-fallback'],
    ['stripeEvent', { id: stripeEventId, type: 'customer.subscription.updated' }],
  ])
  return {
    env: { SUPABASE_DB_URL: 'postgresql://unit.test/db' },
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => {
      variables.set(key, value)
    },
    req: { header: () => undefined, raw: { headers: new Headers() } },
    res: { headers: new Headers() },
  } as any
}

function setupPgMock() {
  pgClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (sql.includes('pg_catalog.to_json')) {
      const plans = sql.includes('name = ANY') ? REVENUE_PLANS : [TEAM_PLAN, MAKER_PLAN]
      return { rows: plans.map(row => ({ row })) }
    }
    if (normalized.includes('SELECT last_stripe_event_at'))
      return { rows: [{ last_stripe_event_at: null, past_due_at: null, status: 'succeeded', paid_at: null }], rowCount: 1 }
    if (normalized.includes('INSERT INTO public.processed_stripe_events'))
      return { rowCount: 0 }
    if (normalized.includes('queue_cron_stat_org_for_org')) {
      queueCalls.push(params ?? [])
      return { rowCount: 1 }
    }
    if (normalized.includes('org_stats_refresh_state'))
      return { rowCount: 1 }
    if (normalized === 'ROLLBACK' || normalized === 'COMMIT' || normalized === 'BEGIN')
      return { rowCount: 0 }
    return { rows: [], rowCount: 0 }
  })
}

describe('createdOrUpdated plan refresh fallback', () => {
  beforeEach(() => {
    checkPlanStatusOnly.mockReset()
    queueCalls.length = 0
    pgClientQuery.mockReset()
    setupPgMock()
  })

  it('queues cron_stat_org when plan recompute fails and still resolves', async () => {
    checkPlanStatusOnly.mockRejectedValueOnce(new Error('recompute failed'))
    const c = makeContext('evt_recompute_fail')
    const stripeData = extractDataEvent(c, makeStripeEvent())
    const currentStripeInfo = {
      customer_id: CUSTOMER_ID,
      product_id: MAKER_PRODUCT_ID,
      price_id: MAKER_PRICE_ID,
      status: 'succeeded',
      last_stripe_event_at: null,
    }
    const originalStatus = stripeData.data.status
    if (originalStatus) {
      stripeData.data.status = resolveActiveSubscriptionStatus(
        originalStatus,
        currentStripeInfo as any,
        stripeData.data.subscription_id,
        'paid',
      )
    }

    await expect(createdOrUpdated(
      c,
      stripeData,
      { id: ORG_ID, name: 'Test org' } as any,
      currentStripeInfo as any,
      new Date().toISOString(),
      originalStatus,
    )).resolves.toBeUndefined()

    expect(checkPlanStatusOnly).toHaveBeenCalled()
    expect(queueCalls).toContainEqual([ORG_ID, CUSTOMER_ID])
  })

  it('still resolves when recompute and queue both fail', async () => {
    checkPlanStatusOnly.mockRejectedValueOnce(new Error('recompute failed'))
    const sqlCalls: string[] = []
    pgClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      sqlCalls.push(sql)
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (sql.includes('pg_catalog.to_json')) {
        const plans = sql.includes('name = ANY') ? REVENUE_PLANS : [TEAM_PLAN, MAKER_PLAN]
        return { rows: plans.map(row => ({ row })) }
      }
      if (normalized.includes('SELECT last_stripe_event_at'))
        return { rows: [{ last_stripe_event_at: null, past_due_at: null, status: 'succeeded', paid_at: null }], rowCount: 1 }
      if (normalized.includes('INSERT INTO public.processed_stripe_events'))
        return { rowCount: 0 }
      if (normalized.includes('queue_cron_stat_org_for_org'))
        throw new Error('queue failed')
      if (normalized.includes('org_stats_refresh_state'))
        return { rowCount: 1 }
      if (normalized === 'ROLLBACK' || normalized === 'COMMIT' || normalized === 'BEGIN')
        return { rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })

    const c = makeContext('evt_queue_fail')
    const stripeData = extractDataEvent(c, makeStripeEvent())
    const currentStripeInfo = {
      customer_id: CUSTOMER_ID,
      product_id: MAKER_PRODUCT_ID,
      price_id: MAKER_PRICE_ID,
      status: 'succeeded',
      last_stripe_event_at: null,
    }

    await expect(createdOrUpdated(
      c,
      stripeData,
      { id: ORG_ID, name: 'Test org' } as any,
      currentStripeInfo as any,
      new Date().toISOString(),
      'updated',
    )).resolves.toBeUndefined()

    const markerIndex = sqlCalls.findIndex(sql => sql.includes('stats_refresh_requested_at'))
    const queueIndex = sqlCalls.findIndex(sql => sql.includes('queue_cron_stat_org_for_org'))
    expect(markerIndex).toBeGreaterThanOrEqual(0)
    expect(queueIndex).toBeGreaterThanOrEqual(0)
    expect(markerIndex).toBeLessThan(queueIndex)
  })
})

describe('refreshPlanStatusAfterStripeSubscriptionChange duplicate and stale', () => {
  const stripeData = {
    data: {
      customer_id: CUSTOMER_ID,
      product_id: TEAM_PRODUCT_ID,
      price_id: TEAM_PRICE_ID,
    },
    previousProductId: MAKER_PRODUCT_ID,
    previousPriceId: MAKER_PRICE_ID,
  } as StripeData

  beforeEach(() => {
    checkPlanStatusOnly.mockReset()
    checkPlanStatusOnly.mockResolvedValue(undefined)
    pgClientQuery.mockReset()
    setupPgMock()
  })

  it('recomputes after duplicate persist outcome', async () => {
    await refreshPlanStatusAfterStripeSubscriptionChange(
      makeContext('evt_duplicate'),
      { id: ORG_ID, name: 'Test org' } as any,
      stripeData,
      'duplicate',
      { product_id: MAKER_PRODUCT_ID, price_id: MAKER_PRICE_ID },
    )
    expect(checkPlanStatusOnly).toHaveBeenCalledOnce()
  })

  it('recomputes after stale persist outcome', async () => {
    await refreshPlanStatusAfterStripeSubscriptionChange(
      makeContext('evt_stale'),
      { id: ORG_ID, name: 'Test org' } as any,
      stripeData,
      'stale',
      { product_id: MAKER_PRODUCT_ID, price_id: MAKER_PRICE_ID },
    )
    expect(checkPlanStatusOnly).toHaveBeenCalledOnce()
  })
})