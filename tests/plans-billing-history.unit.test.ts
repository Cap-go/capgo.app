import type { OrganizationBillingHistory } from '../supabase/functions/_backend/utils/plans_billing_history.ts'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyPlansBillingAt,
  loadPlansBillingHistories,

} from '../supabase/functions/_backend/utils/plans_billing_history.ts'

const {
  closeClientMock,
  getPgClientMock,
  pgConnectMock,
  pgQueryMock,
  pgReleaseMock,
} = vi.hoisted(() => {
  const pgQueryMock = vi.fn()
  const pgReleaseMock = vi.fn()
  const pgConnectMock = vi.fn(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
  return {
    closeClientMock: vi.fn(),
    getPgClientMock: vi.fn(() => ({ connect: pgConnectMock })),
    pgConnectMock,
    pgQueryMock,
    pgReleaseMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

const at = Date.parse('2026-08-01T12:00:00Z')
function base(): OrganizationBillingHistory {
  return {
    orgId: 'org-a',
    customerId: 'cus-a',
    trialEndsAtMs: Date.parse('2026-07-01T00:00:00Z'),
    paidAtMs: null,
    canceledAtMs: null,
    currentPastDueAtMs: null,
    churnReason: null,
    revenueMovements: [],
    transitions: [],
    creditGrants: [],
    creditConsumptions: [],
  }
}

function normalizedQuery(query: unknown) {
  return String(query).replace(/\s+/g, ' ').trim()
}

function context() {
  return { get: vi.fn(() => 'request-id') } as never
}

describe('plans billing history classification', () => {
  it.each([
    ['active payment problem beats paying', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      currentPastDueAtMs: Date.parse('2026-07-20T00:00:00Z'),
      revenueMovements: [{ date: '2026-06-01', openingMrr: 0, newBusinessMrr: 12, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
    }, 'payment_problem'],
    ['carried positive MRR is paying', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{
        date: '2026-06-01',
        openingMrr: 0,
        newBusinessMrr: 12,
        expansionMrr: 0,
        contractionMrr: 0,
        churnMrr: 0,
        churnReason: null,
      }],
    }, 'paying'],
    ['future trial end is active trial', {
      ...base(),
      trialEndsAtMs: Date.parse('2026-08-10T00:00:00Z'),
    }, 'active_trial'],
    ['positive unexpired credits are credits only', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: Date.parse('2026-07-01T00:00:00Z'), expiresAtMs: Date.parse('2026-09-01T00:00:00Z'), creditsTotal: 10 }],
    }, 'credits_only'],
    ['previously paid voluntary ended entitlement is canceled', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-07-01T00:00:00Z'),
    }, 'canceled'],
    ['never-paid ended trial is expired trial', base(), 'expired_trial'],
  ] as const)('%s', (_label, history, expected) => {
    expect(classifyPlansBillingAt(history, at)).toBe(expected)
  })

  it.concurrent('returns unknown for a movement-day mismatch without a locating transition', () => {
    const history = {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: null }],
    }
    expect(classifyPlansBillingAt(history, at)).toBe('unknown')
  })

  it.concurrent('keeps a visit before a later same-day cancel paying', () => {
    expect(classifyPlansBillingAt({
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: null }],
      transitions: [{ timestampMs: Date.parse('2026-08-01T14:00:00Z'), kind: 'canceled' }],
    }, Date.parse('2026-08-01T13:00:00Z'))).toBe('paying')
  })

  it.each([
    ['payment-failure churn with a transition', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: 'past_due_unresolved' }],
      transitions: [{ timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'payment_problem' as const }],
    }, at, 'payment_problem'],
    ['recovered past due is paying', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-06-01', openingMrr: 0, newBusinessMrr: 12, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
      transitions: [
        { timestampMs: Date.parse('2026-08-01T09:00:00Z'), kind: 'payment_problem' as const },
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'recovered' as const },
      ],
    }, at, 'paying'],
    ['resubscribed after cancel is paying', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-07-01T00:00:00Z'),
      transitions: [
        { timestampMs: Date.parse('2026-07-01T00:00:00Z'), kind: 'canceled' as const },
        { timestampMs: Date.parse('2026-08-01T11:00:00Z'), kind: 'paid' as const },
      ],
    }, at, 'paying'],
    ['fully consumed credits do not count', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: Date.parse('2026-07-01T00:00:00Z'), expiresAtMs: Date.parse('2026-09-01T00:00:00Z'), creditsTotal: 10 }],
      creditConsumptions: [{ grantId: 'grant-a', appliedAtMs: Date.parse('2026-07-20T00:00:00Z'), creditsUsed: 10 }],
    }, at, 'expired_trial'],
    ['expired credits do not count', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: Date.parse('2026-06-01T00:00:00Z'), expiresAtMs: Date.parse('2026-07-01T00:00:00Z'), creditsTotal: 10 }],
    }, at, 'expired_trial'],
  ] as const)('%s', (_label, history, timestamp, expected) => {
    expect(classifyPlansBillingAt(history, timestamp)).toBe(expected)
  })

  it.concurrent('returns unknown for contradictory transitions at one instant', () => {
    expect(classifyPlansBillingAt({
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      transitions: [
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'paid' },
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'canceled' },
      ],
    }, at)).toBe('unknown')
  })

  it.concurrent('allows later definitive evidence to supersede a contradictory instant', () => {
    const history = {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      transitions: [
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'paid' as const },
        { timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'canceled' as const },
        { timestampMs: Date.parse('2026-08-02T10:00:00Z'), kind: 'paid' as const },
      ],
    }

    expect(classifyPlansBillingAt(history, Date.parse('2026-08-01T12:00:00Z'))).toBe('unknown')
    expect(classifyPlansBillingAt(history, Date.parse('2026-08-02T12:00:00Z'))).toBe('paying')
  })

  it.concurrent('applies scalar cancellation evidence after older paid evidence', () => {
    expect(classifyPlansBillingAt({
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-07-01T00:00:00Z'),
      revenueMovements: [{ date: '2026-06-01', openingMrr: 0, newBusinessMrr: 12, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
      transitions: [{ timestampMs: Date.parse('2026-06-01T01:00:00Z'), kind: 'paid' }],
    }, at)).toBe('canceled')
  })

  it.concurrent('uses paidAt as paying evidence before a future cancellation and future trial end', () => {
    expect(classifyPlansBillingAt({
      ...base(),
      trialEndsAtMs: Date.parse('2026-08-10T00:00:00Z'),
      paidAtMs: Date.parse('2026-08-01T10:00:00Z'),
      canceledAtMs: Date.parse('2026-08-01T14:00:00Z'),
    }, at)).toBe('paying')
  })

  it.each([
    ['paidAt locates a zero-to-positive movement', {
      ...base(),
      paidAtMs: Date.parse('2026-08-01T10:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 0, newBusinessMrr: 12, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
    }, 'paying'],
    ['canceledAt locates a positive-to-zero movement', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-08-01T10:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: null }],
    }, 'canceled'],
  ] as const)('%s', (_label, history, expected) => {
    expect(classifyPlansBillingAt(history, at)).toBe(expected)
  })

  it.concurrent('returns unknown for contradictory scalar and explicit transitions at one instant', () => {
    expect(classifyPlansBillingAt({
      ...base(),
      paidAtMs: Date.parse('2026-08-01T10:00:00Z'),
      transitions: [{ timestampMs: Date.parse('2026-08-01T10:00:00Z'), kind: 'canceled' }],
    }, at)).toBe('unknown')
  })

  it.each([
    ['movement churn reason', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-08-01T10:00:00Z'),
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: 'past_due_unresolved' }],
    }],
    ['organization churn reason', {
      ...base(),
      paidAtMs: Date.parse('2026-06-01T00:00:00Z'),
      canceledAtMs: Date.parse('2026-08-01T10:00:00Z'),
      churnReason: 'past_due_unresolved',
      revenueMovements: [{ date: '2026-08-01', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 12, churnReason: null }],
    }],
  ] as const)('classifies payment-failure churn from %s without an explicit transition', (_label, history) => {
    expect(classifyPlansBillingAt(history, at)).toBe('payment_problem')
  })

  it.each([
    ['non-finite visit timestamp', base(), Number.NaN],
    ['non-finite cancellation timestamp', { ...base(), canceledAtMs: Number.NaN }, at],
    ['non-finite transition timestamp', { ...base(), transitions: [{ timestampMs: Number.NaN, kind: 'paid' as const }] }, at],
    ['invalid revenue date', { ...base(), revenueMovements: [{ date: 'not-a-date', openingMrr: 12, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }] }, at],
    ['non-finite MRR', { ...base(), revenueMovements: [{ date: '2026-07-01', openingMrr: Number.NaN, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }] }, at],
    ['non-finite grant timestamp', { ...base(), creditGrants: [{ id: 'grant-a', grantedAtMs: Number.NaN, expiresAtMs: at + 1000, creditsTotal: 10 }] }, at],
    ['non-finite credit quantity', { ...base(), creditGrants: [{ id: 'grant-a', grantedAtMs: at - 1000, expiresAtMs: at + 1000, creditsTotal: Number.POSITIVE_INFINITY }] }, at],
    ['non-finite consumption evidence', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: at - 1000, expiresAtMs: at + 1000, creditsTotal: 10 }],
      creditConsumptions: [{ grantId: 'grant-a', appliedAtMs: at - 500, creditsUsed: Number.NaN }],
    }, at],
  ] as const)('returns unknown without throwing for %s', (_label, history, timestamp) => {
    expect(() => classifyPlansBillingAt(history, timestamp)).not.toThrow()
    expect(classifyPlansBillingAt(history, timestamp)).toBe('unknown')
  })

  it.each([
    ['negative opening MRR', {
      ...base(),
      revenueMovements: [{ date: '2026-07-01', openingMrr: -1, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
    }],
    ['negative credit total', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: at - 1000, expiresAtMs: at + 1000, creditsTotal: -1 }],
    }],
    ['zero credit consumption', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: at - 1000, expiresAtMs: at + 1000, creditsTotal: 10 }],
      creditConsumptions: [{ grantId: 'grant-a', appliedAtMs: at - 500, creditsUsed: 0 }],
    }],
    ['negative credit consumption', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: at - 1000, expiresAtMs: at + 1000, creditsTotal: 10 }],
      creditConsumptions: [{ grantId: 'grant-a', appliedAtMs: at - 500, creditsUsed: -1 }],
    }],
    ['reversed grant interval', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: at + 1000, expiresAtMs: at - 1000, creditsTotal: 10 }],
    }],
  ] as const)('returns unknown for impossible finite evidence: %s', (_label, history) => {
    expect(classifyPlansBillingAt(history, at)).toBe('unknown')
  })

  it.each([
    ['zero MRR', {
      ...base(),
      revenueMovements: [{ date: '2026-07-01', openingMrr: 0, newBusinessMrr: 0, expansionMrr: 0, contractionMrr: 0, churnMrr: 0, churnReason: null }],
    }],
    ['zero credit grant', {
      ...base(),
      creditGrants: [{ id: 'grant-a', grantedAtMs: at, expiresAtMs: at, creditsTotal: 0 }],
    }],
  ] as const)('keeps legitimate boundary evidence valid: %s', (_label, history) => {
    expect(classifyPlansBillingAt(history, at)).toBe('expired_trial')
  })
})

describe('loadPlansBillingHistories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses bounded parameterized queries and reconstructs relevant histories', async () => {
    pgQueryMock
      .mockResolvedValueOnce({ rows: [
        { org_id: 'org-a', customer_id: 'cus-a', trial_at: '2026-08-10T00:00:00Z', paid_at: '2026-07-01T00:00:00Z', canceled_at: null, past_due_at: null, churn_reason: null },
        { org_id: 'org-b', customer_id: null, trial_at: '2026-07-01T00:00:00Z', paid_at: null, canceled_at: null, past_due_at: null, churn_reason: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        { customer_id: 'cus-a', date_id: '2026-07-31', opening_mrr: 10, new_business_mrr: 0, expansion_mrr: 2, contraction_mrr: 0, churn_mrr: 0, churn_reason: null },
        { customer_id: 'cus-a', date_id: '2026-08-01', opening_mrr: 12, new_business_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churn_mrr: 0, churn_reason: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        { id: 'grant-a', org_id: 'org-a', granted_at: '2026-07-20T00:00:00Z', expires_at: '2026-09-01T00:00:00Z', credits_total: '10' },
        { id: 'grant-b', org_id: 'org-b', granted_at: '2026-08-02T00:00:00Z', expires_at: '2026-08-31T00:00:00Z', credits_total: '4' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { grant_id: 'grant-a', org_id: 'org-a', applied_at: '2026-08-03T00:00:00Z', credits_used: '3' },
      ] })

    const transitions = new Map([['org-a', [{ timestampMs: at, kind: 'paid' as const }]]])
    const result = await loadPlansBillingHistories(context(), ['org-a', 'org-b'], '2026-08-01', '2026-08-07', transitions)

    expect(getPgClientMock).toHaveBeenCalledOnce()
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), true)
    expect(pgConnectMock).toHaveBeenCalledOnce()
    expect(pgQueryMock).toHaveBeenCalledTimes(4)

    const calls = pgQueryMock.mock.calls.map(([query, params]) => ({ sql: normalizedQuery(query), params }))
    expect(calls[0]).toMatchObject({ params: [['org-a', 'org-b']] })
    expect(calls[0]!.sql).toContain('WHERE o.id = ANY($1::uuid[])')
    expect(calls[1]).toMatchObject({ params: [['cus-a'], '2026-08-01', '2026-08-07'] })
    expect(calls[1]!.sql).toContain('FROM unnest($1::text[]) AS customer_id')
    expect(calls[1]!.sql).toContain('CROSS JOIN LATERAL')
    expect(calls[1]!.sql).toContain('FROM public.processed_stripe_events pse')
    expect(calls[1]!.sql).toContain('pse.customer_id = rc.customer_id')
    expect(calls[1]!.sql).toContain('JOIN public.daily_revenue_metrics drm ON drm.date_id = pse.date_id AND drm.customer_id = pse.customer_id')
    expect(calls[1]!.sql).toContain('pse.date_id < $2::text')
    expect(calls[1]!.sql).toContain('ORDER BY pse.date_id DESC LIMIT 1')
    expect(calls[1]!.sql).toContain('SELECT DISTINCT pse.date_id')
    expect(calls[1]!.sql).toContain('pse.date_id BETWEEN $2::text AND $3::text')
    expect(calls[1]!.sql).toContain('drm.date_id = movement_dates.date_id')
    expect(calls[1]!.sql).toContain('drm.customer_id = rc.customer_id')
    expect(calls[1]!.sql).not.toContain('drm.customer_id = ANY($1::text[])')
    expect(calls[1]!.sql).not.toContain('drm.date_id BETWEEN $2::text AND $3::text')
    expect(calls[2]).toMatchObject({ params: [['org-a', 'org-b'], '2026-08-01', '2026-08-07'] })
    expect(calls[2]!.sql).toContain('g.org_id = ANY($1::uuid[])')
    expect(calls[2]!.sql).toContain('g.granted_at < ($3::date + INTERVAL \'1 day\')')
    expect(calls[2]!.sql).toContain('g.expires_at >= $2::date')
    expect(calls[3]).toMatchObject({ params: [['grant-a', 'grant-b'], '2026-08-07'] })
    expect(calls[3]!.sql).toContain('c.grant_id = ANY($1::uuid[])')
    expect(calls[3]!.sql).toContain('c.applied_at < ($2::date + INTERVAL \'1 day\')')

    expect(result.get('org-a')).toMatchObject({
      orgId: 'org-a',
      customerId: 'cus-a',
      revenueMovements: [{ date: '2026-07-31' }, { date: '2026-08-01' }],
      transitions: [{ timestampMs: at, kind: 'paid' }],
      creditGrants: [{ id: 'grant-a', creditsTotal: 10 }],
      creditConsumptions: [{ grantId: 'grant-a', creditsUsed: 3 }],
    })
    expect(result.get('org-b')).toMatchObject({ customerId: null, creditGrants: [{ id: 'grant-b', creditsTotal: 4 }] })
    expect(pgReleaseMock).toHaveBeenCalledOnce()
    expect(closeClientMock).toHaveBeenCalledWith(expect.anything(), getPgClientMock.mock.results[0]!.value)
  })

  it('releases the client and closes the pool when a bounded query fails', async () => {
    pgQueryMock.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(loadPlansBillingHistories(context(), ['org-a'], '2026-08-01', '2026-08-07', new Map()))
      .rejects
      .toThrow('database unavailable')

    expect(pgReleaseMock).toHaveBeenCalledOnce()
    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it('preserves malformed loaded numerics so classification remains unknown', async () => {
    pgQueryMock
      .mockResolvedValueOnce({ rows: [
        { org_id: 'org-a', customer_id: 'cus-a', trial_at: '2026-07-01T00:00:00Z', paid_at: null, canceled_at: null, past_due_at: null, churn_reason: null },
      ] })
      .mockResolvedValueOnce({ rows: [
        { customer_id: 'cus-a', date_id: '2026-07-31', opening_mrr: 'invalid', new_business_mrr: 0, expansion_mrr: 0, contraction_mrr: 0, churn_mrr: 0, churn_reason: null },
      ] })
      .mockResolvedValueOnce({ rows: [] })

    const histories = await loadPlansBillingHistories(context(), ['org-a'], '2026-08-01', '2026-08-07', new Map())
    const history = histories.get('org-a')!

    expect(Number.isNaN(history.revenueMovements[0]!.openingMrr)).toBe(true)
    expect(classifyPlansBillingAt(history, at)).toBe('unknown')
  })

  it('does not open an unbounded database query for an empty organization set', async () => {
    await expect(loadPlansBillingHistories(context(), [], '2026-08-01', '2026-08-07', new Map()))
      .resolves
      .toEqual(new Map())

    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(pgQueryMock).not.toHaveBeenCalled()
  })
})
