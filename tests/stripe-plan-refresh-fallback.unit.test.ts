import type { StripeData } from '../supabase/functions/_backend/utils/stripe.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkPlanStatusOnly = vi.hoisted(() => vi.fn())
const pgQuery = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getPgClient = vi.hoisted(() => vi.fn().mockResolvedValue({ query: pgQuery }))
const closeClient = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  return {
    ...mod,
    getPgClient,
    closeClient,
  }
})

vi.mock('../supabase/functions/_backend/utils/plans.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../supabase/functions/_backend/utils/plans.ts')>()
  return {
    ...mod,
    checkPlanStatusOnly,
  }
})

import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

const { refreshPlanStatusAfterStripeSubscriptionChange } = stripeEventTestUtils

const ORG_ID = '00000000-0000-4000-8000-00000000a001'
const CUSTOMER_ID = 'cus_plan_refresh_fallback'

const mockContext = {
  get: () => 'test-request-id',
  env: {},
} as any

function makeStripeData(): StripeData {
  return {
    data: {
      customer_id: CUSTOMER_ID,
      product_id: 'prod_team',
      price_id: 'price_team',
    },
    previousProductId: 'prod_maker',
    previousPriceId: 'price_maker',
  } as StripeData
}

describe('refreshPlanStatusAfterStripeSubscriptionChange fallback', () => {
  beforeEach(() => {
    checkPlanStatusOnly.mockReset()
    pgQuery.mockReset()
    pgQuery.mockResolvedValue(undefined)
    getPgClient.mockClear()
    closeClient.mockClear()
  })

  it('queues cron_stat_org when plan recompute fails', async () => {
    checkPlanStatusOnly.mockRejectedValueOnce(new Error('recompute failed'))

    await refreshPlanStatusAfterStripeSubscriptionChange(
      mockContext,
      { id: ORG_ID, name: 'Test org' } as any,
      makeStripeData(),
      'applied',
      { product_id: 'prod_maker', price_id: 'price_maker' },
    )

    expect(checkPlanStatusOnly).toHaveBeenCalledOnce()
    expect(pgQuery).toHaveBeenCalledWith(
      'SELECT public.queue_cron_stat_org_for_org($1::uuid, $2::text)',
      [ORG_ID, CUSTOMER_ID],
    )
  })

  it('resolves when recompute and queue both fail', async () => {
    checkPlanStatusOnly.mockRejectedValueOnce(new Error('recompute failed'))
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('queue_cron_stat_org_for_org'))
        throw new Error('queue failed')
    })

    await expect(refreshPlanStatusAfterStripeSubscriptionChange(
      mockContext,
      { id: ORG_ID, name: 'Test org' } as any,
      makeStripeData(),
      'applied',
      { product_id: 'prod_maker', price_id: 'price_maker' },
    )).resolves.toBeUndefined()
  })

  it('queues cron_stat_org when touch fails during fallback', async () => {
    checkPlanStatusOnly.mockRejectedValueOnce(new Error('recompute failed'))
    let queueSeen = false
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('org_stats_refresh_state'))
        throw new Error('touch failed')
      if (sql.includes('queue_cron_stat_org_for_org')) {
        queueSeen = true
        return undefined
      }
    })

    await refreshPlanStatusAfterStripeSubscriptionChange(
      mockContext,
      { id: ORG_ID, name: 'Test org' } as any,
      makeStripeData(),
      'applied',
      { product_id: 'prod_maker', price_id: 'price_maker' },
    )

    expect(queueSeen).toBe(true)
  })
})