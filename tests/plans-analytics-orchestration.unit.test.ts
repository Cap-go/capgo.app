import type { Context } from 'hono'
import type { OrganizationBillingHistory } from '../supabase/functions/_backend/utils/plans_billing_history.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBillingTransitionsQuery,
  buildExactTrackingStartQuery,
  buildPlansBehaviorQuery,
  getAdminPlansAnalytics,
  LEGACY_PATH_SOURCE,
  MAX_PLANS_ORGANIZATIONS,
  MAX_POSTHOG_ROWS,
  MAX_TRANSITION_RESPONSE_BYTES,
  TRACKING_HISTORY_START,
  TRANSITION_QUERY_CONCURRENCY,
} from '../supabase/functions/_backend/utils/plans_analytics.ts'
import { loadPlansBillingHistories } from '../supabase/functions/_backend/utils/plans_billing_history.ts'
import { queryPosthogHogql } from '../supabase/functions/_backend/utils/posthog_read.ts'

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/posthog_read.ts')>(),
  queryPosthogHogql: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/plans_billing_history.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/plans_billing_history.ts')>(),
  loadPlansBillingHistories: vi.fn(),
}))

const start = '2026-08-01T00:00:00.000Z'
const end = '2026-08-02T00:00:00.000Z'
const startMs = Date.parse(start)
const context = { get: vi.fn(() => 'request-id') } as unknown as Context
const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'
const ORG_C = '00000000-0000-4000-8000-00000000000c'
const ORG_D = '00000000-0000-4000-8000-00000000000d'
const ORG_E = '00000000-0000-4000-8000-00000000000e'
const ORG_F = '00000000-0000-4000-8000-00000000000f'
const ORG_X = '00000000-0000-4000-8000-000000000010'
const ORG_GROUPED = '00000000-0000-4000-8000-000000000011'
const ORG_PAID = '00000000-0000-4000-8000-000000000012'
const ORG_CANCELED = '00000000-0000-4000-8000-000000000013'
const ORG_KNOWN = '00000000-0000-4000-8000-000000000014'
const ORG_UNKNOWN = '00000000-0000-4000-8000-000000000015'
const EXPECTED_TRANSITION_QUERY_CONCURRENCY = 4
const EXPECTED_MAX_PLANS_ORGANIZATIONS = 4_000
const EXPECTED_MAX_TRANSITION_RESPONSE_BYTES = 2 * 1024 * 1024

function connected(rows: Record<string, unknown>[] = []) {
  return {
    configured: true,
    connected: true,
    failureReason: null,
    rows,
  } as const
}

function rowsWithLength(length: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  rows.length = length
  return rows
}

function organizationIds(length: number): string[] {
  return Array.from({ length }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)
}

function behavior(overrides: Record<string, unknown> = {}) {
  return {
    timestamp_ms: startMs + 60_000,
    event: 'User visit',
    org_id: ORG_A,
    grouped_org_id: '',
    page: 'plans',
    session_id: 'session-a',
    distinct_id: 'user-a',
    ...overrides,
  }
}

function history(orgId: string, overrides: Partial<OrganizationBillingHistory> = {}): OrganizationBillingHistory {
  return {
    orgId,
    customerId: null,
    trialEndsAtMs: Date.parse('2026-08-10T00:00:00Z'),
    paidAtMs: null,
    canceledAtMs: null,
    currentPastDueAtMs: null,
    churnReason: null,
    revenueMovements: [],
    transitions: [],
    creditGrants: [],
    creditConsumptions: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map())
})

describe('plans analytics query construction', () => {
  it.concurrent('builds bounded scalar-only behavior, transition, and exact-boundary queries', () => {
    const behaviorQuery = buildPlansBehaviorQuery(start, end)
    expect(behaviorQuery).toContain('toUnixTimestamp64Milli(timestamp) AS timestamp_ms')
    expect(behaviorQuery).toContain('event IN (\'User visit\', \'Checkout Started\')')
    expect(behaviorQuery).toContain('2026-07-31T23:59:30.000Z')
    expect(behaviorQuery).toContain('2026-08-03T00:00:00.000Z')
    expect(behaviorQuery).toContain('event = \'User visit\'\n    AND properties.page = \'plans\'\n    AND timestamp >= parseDateTimeBestEffort(\'2026-07-31T23:59:30.000Z\')\n    AND timestamp < parseDateTimeBestEffort(\'2026-08-02T00:00:00.000Z\')')
    expect(behaviorQuery).toContain('event = \'Checkout Started\'\n    AND timestamp >= parseDateTimeBestEffort(\'2026-08-01T00:00:00.000Z\')\n    AND timestamp < parseDateTimeBestEffort(\'2026-08-03T00:00:00.000Z\')')
    expect(behaviorQuery).toContain('LIMIT 200001')
    expect(behaviorQuery).not.toMatch(/SELECT\s+properties\b/i)
    expect(behaviorQuery).not.toContain('current_url')
    expect(behaviorQuery).not.toContain('pathname')

    const transitionQuery = buildBillingTransitionsQuery(end, [ORG_A, ORG_B])
    expect(transitionQuery).toContain('toUnixTimestamp64Milli(timestamp) AS timestamp_ms')
    expect(transitionQuery).toContain('event IN (\'User subscribe\', \'User update subscribe\', \'User cancel\', \'$groupidentify\')')
    expect(transitionQuery).toContain(TRACKING_HISTORY_START)
    expect(transitionQuery).toContain('2026-08-03T00:00:00.000Z')
    expect(transitionQuery).toContain('properties.plan_status AS event_plan_status')
    expect(transitionQuery).toContain(`properties.$group_key IN ('${ORG_A}', '${ORG_B}')`)
    expect(transitionQuery).toContain(`properties.$groups.organization IN ('${ORG_A}', '${ORG_B}')`)
    expect(transitionQuery).toContain('LIMIT 200001')
    expect(transitionQuery).not.toMatch(/SELECT\s+properties\b/i)

    const exactQuery = buildExactTrackingStartQuery()
    expect(exactQuery).toContain('properties.page = \'plans\'')
    expect(exactQuery).toContain(TRACKING_HISTORY_START)
    expect(exactQuery).toContain('timestamp < now()')
    expect(exactQuery).toContain('LIMIT 200001')
  })

  it.concurrent('filters non-Plans visit noise before it can consume the PostHog row ceiling', () => {
    const behaviorQuery = buildPlansBehaviorQuery(start, end)
    const visitBranchStart = behaviorQuery.indexOf('(event = \'User visit\'')
    const checkoutBranchStart = behaviorQuery.indexOf('(event = \'Checkout Started\'')
    const limit = behaviorQuery.indexOf(`LIMIT ${MAX_POSTHOG_ROWS + 1}`)
    const visitBranch = behaviorQuery.slice(visitBranchStart, checkoutBranchStart)

    expect(visitBranchStart).toBeGreaterThan(-1)
    expect(checkoutBranchStart).toBeGreaterThan(visitBranchStart)
    expect(limit).toBeGreaterThan(checkoutBranchStart)
    expect(visitBranch).toContain("properties.page = 'plans'")
  })

  it.concurrent('escapes date scalar literals and validates dates before constructing queries', () => {
    expect(buildPlansBehaviorQuery('2026-08-01T00:00:00.000Z\' OR 1=1', end)).toBe('')
    expect(buildBillingTransitionsQuery('not-a-date', [ORG_A])).toBe('')
    expect(buildBillingTransitionsQuery('+275760-09-12T23:59:59.999Z', [ORG_A])).toBe('')
    expect(buildBillingTransitionsQuery(end, ['bad\'id'])).toContain('\'bad\'\'id\'')
    expect(() => buildPlansBehaviorQuery('not-a-date', end)).not.toThrow()
  })
})

describe('plans analytics orchestration', () => {
  it.each([
    ['unconfigured', { configured: false, connected: false, failureReason: 'unconfigured' as const, rows: [] }],
    ['timeout', { configured: true, connected: false, failureReason: 'timeout' as const, rows: [] }],
    ['unavailable', { configured: true, connected: false, failureReason: 'unavailable' as const, rows: [] }],
    ['too large', { configured: true, connected: true, failureReason: 'too_large' as const, rows: [] }],
  ])('returns a structured %s state', async (_label, failure) => {
    vi.mocked(queryPosthogHogql).mockResolvedValue(failure)

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({
      posthogConfigured: failure.configured,
      posthogConnected: failure.connected,
      posthogFailureReason: failure.failureReason,
      legacyReconstructionAvailable: false,
      legacyUnavailableReason: 'missing_event_time_path',
      legacyLogicalOpens: 0,
      legacyDeduplicationSeconds: null,
    })
    expect(result.traffic.totalOpens).toEqual([0])
    expect(result.visitorBreakdown).toHaveLength(1)
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('rejects a row-ceiling result instead of returning partial charts', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected(rowsWithLength(MAX_POSTHOG_ROWS + 1)))
      .mockResolvedValue(connected())

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({
      posthogConfigured: true,
      posthogConnected: true,
      posthogFailureReason: 'too_large',
    })
    expect(result.traffic.totalOpens).toEqual([0])
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('distinguishes connected empty data from unavailable data', async () => {
    vi.mocked(queryPosthogHogql).mockResolvedValue(connected())

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({ posthogConfigured: true, posthogConnected: true, posthogFailureReason: null })
    expect(result.traffic).toEqual({ dates: ['2026-08-01'], uniqueVisitorOrganizations: [0], totalOpens: [0] })
    expect(queryPosthogHogql).toHaveBeenCalledTimes(2)
    expect(vi.mocked(queryPosthogHogql).mock.calls[1]?.[1]).toContain('SELECT min(timestamp) AS exact_tracking_started_at')
  })

  it('runs behavior first and scopes transitions to the relevant opening organizations', async () => {
    const queries: string[] = []
    vi.mocked(queryPosthogHogql).mockImplementation(async (_context, query) => {
      queries.push(query)
      if (queries.length === 1)
        return connected([behavior(), behavior({ org_id: ORG_B, distinct_id: 'user-b' })])
      return connected()
    })

    await getAdminPlansAnalytics(context, start, end)

    expect(queries[0]).toContain('event IN (\'User visit\', \'Checkout Started\')')
    expect(queries[1]).toContain(`properties.$group_key IN ('${ORG_A}', '${ORG_B}')`)
    expect(queries[1]).not.toContain(ORG_X)
    expect(queries[2]).toContain('SELECT min(timestamp) AS exact_tracking_started_at')
    expect(loadPlansBillingHistories).toHaveBeenCalledWith(context, [ORG_A, ORG_B], '2026-08-01', '2026-08-02', new Map())
  })

  it('batches large relevant organization sets deterministically', async () => {
    const orgIds = organizationIds(1_001)
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected(orgIds.map(orgId => behavior({ org_id: orgId }))))
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce(connected())

    await getAdminPlansAnalytics(context, start, end)

    const firstTransitionQuery = vi.mocked(queryPosthogHogql).mock.calls[1]?.[1] ?? ''
    const secondTransitionQuery = vi.mocked(queryPosthogHogql).mock.calls[2]?.[1] ?? ''
    expect(firstTransitionQuery).toContain(orgIds[0])
    expect(firstTransitionQuery).toContain(orgIds[999])
    expect(firstTransitionQuery).not.toContain(orgIds[1_000])
    expect(secondTransitionQuery).toContain(orgIds[1_000])
    expect(secondTransitionQuery).not.toContain(orgIds[0])
    expect(loadPlansBillingHistories).toHaveBeenCalledWith(context, orgIds, '2026-08-01', '2026-08-02', new Map())
  })

  it('rejects organization cardinality above the single-wave ceiling before transition or billing work', async () => {
    const orgIds = organizationIds(EXPECTED_MAX_PLANS_ORGANIZATIONS + 1)
    vi.mocked(queryPosthogHogql).mockResolvedValueOnce(connected(orgIds.map(orgId => behavior({ org_id: orgId }))))

    expect(MAX_PLANS_ORGANIZATIONS).toBe(EXPECTED_MAX_PLANS_ORGANIZATIONS)
    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality.posthogFailureReason).toBe('too_large')
    expect(queryPosthogHogql).toHaveBeenCalledTimes(1)
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('runs the maximum organization set in one bounded transition-query wave', async () => {
    const orgIds = organizationIds(EXPECTED_MAX_PLANS_ORGANIZATIONS)
    let activeTransitions = 0
    let maxActiveTransitions = 0
    vi.mocked(queryPosthogHogql).mockImplementation(async (_context, query) => {
      if (query.includes('event IN (\'User visit\', \'Checkout Started\')'))
        return connected(orgIds.map(orgId => behavior({ org_id: orgId })))
      if (query.includes('SELECT min(timestamp) AS exact_tracking_started_at'))
        return connected()

      activeTransitions += 1
      maxActiveTransitions = Math.max(maxActiveTransitions, activeTransitions)
      await new Promise(resolve => setTimeout(resolve, 1))
      activeTransitions -= 1
      return connected()
    })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(TRANSITION_QUERY_CONCURRENCY).toBe(EXPECTED_TRANSITION_QUERY_CONCURRENCY)
    expect(MAX_TRANSITION_RESPONSE_BYTES).toBe(EXPECTED_MAX_TRANSITION_RESPONSE_BYTES)
    expect(maxActiveTransitions).toBe(EXPECTED_TRANSITION_QUERY_CONCURRENCY)
    const transitionCalls = vi.mocked(queryPosthogHogql).mock.calls.filter(([, query]) => query.includes('event IN (\'User subscribe\''))
    expect(transitionCalls).toHaveLength(EXPECTED_TRANSITION_QUERY_CONCURRENCY)
    expect(transitionCalls.every(([, , options]) => options?.maxResponseBytes === EXPECTED_MAX_TRANSITION_RESPONSE_BYTES)).toBe(true)
    const behaviorCall = vi.mocked(queryPosthogHogql).mock.calls.find(([, query]) => query.includes('event IN (\'User visit\''))
    const boundaryCall = vi.mocked(queryPosthogHogql).mock.calls.find(([, query]) => query.includes('SELECT min(timestamp)'))
    expect(behaviorCall?.[2]).toBeUndefined()
    expect(boundaryCall?.[2]).toBeUndefined()
    expect(result.dataQuality.posthogFailureReason).toBeNull()
    expect(loadPlansBillingHistories).toHaveBeenCalledWith(context, orgIds, '2026-08-01', '2026-08-02', new Map())
  })

  it('fails closed after a concurrent transition batch fails', async () => {
    const orgIds = organizationIds(EXPECTED_MAX_PLANS_ORGANIZATIONS)
    vi.mocked(queryPosthogHogql).mockImplementation(async (_context, query) => {
      if (query.includes('event IN (\'User visit\', \'Checkout Started\')'))
        return connected(orgIds.map(orgId => behavior({ org_id: orgId })))
      if (query.includes(orgIds[1_000]))
        return { configured: true, connected: false, failureReason: 'timeout', rows: [] }
      return connected()
    })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({ posthogConnected: false, posthogFailureReason: 'timeout' })
    expect(queryPosthogHogql).toHaveBeenCalledTimes(1 + EXPECTED_TRANSITION_QUERY_CONCURRENCY)
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('fails closed when a transition response exceeds its share of the wave budget', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([behavior()]))
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: 'too_large', rows: [] })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({ posthogConnected: true, posthogFailureReason: 'too_large' })
    expect(queryPosthogHogql).toHaveBeenCalledTimes(2)
    expect(vi.mocked(queryPosthogHogql).mock.calls[1]?.[2]).toEqual({ maxResponseBytes: EXPECTED_MAX_TRANSITION_RESPONSE_BYTES })
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('applies the global transition row ceiling across concurrent batches', async () => {
    const orgIds = organizationIds(2_000)
    let transitionBatch = 0
    vi.mocked(queryPosthogHogql).mockImplementation(async (_context, query) => {
      if (query.includes('event IN (\'User visit\', \'Checkout Started\')'))
        return connected(orgIds.map(orgId => behavior({ org_id: orgId })))
      if (query.includes('SELECT min(timestamp) AS exact_tracking_started_at'))
        return connected()
      transitionBatch += 1
      return connected(rowsWithLength(transitionBatch === 1 ? 100_001 : 100_000))
    })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality.posthogFailureReason).toBe('too_large')
    expect(queryPosthogHogql).toHaveBeenCalledTimes(3)
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('prevents unrelated global transitions from consuming the row ceiling', async () => {
    vi.mocked(queryPosthogHogql).mockImplementation(async (_context, query) => {
      if (query.includes('event IN (\'User visit\', \'Checkout Started\')'))
        return connected([behavior()])
      if (query.includes(`properties.$group_key IN ('${ORG_A}')`))
        return connected()
      if (query.includes('SELECT min(timestamp) AS exact_tracking_started_at'))
        return connected()
      return connected(rowsWithLength(MAX_POSTHOG_ROWS + 1))
    })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality.posthogFailureReason).toBeNull()
    expect(result.traffic.totalOpens).toEqual([1])
  })

  it('returns a structured transition failure after successful behavior mapping', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([behavior()]))
      .mockResolvedValueOnce({ configured: true, connected: false, failureReason: 'timeout', rows: [] })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({ posthogConfigured: true, posthogConnected: false, posthogFailureReason: 'timeout' })
    expect(queryPosthogHogql).toHaveBeenCalledTimes(2)
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })

  it('fails closed when a transport is disconnected without a failure reason', async () => {
    vi.mocked(queryPosthogHogql).mockResolvedValue({ configured: true, connected: false, failureReason: null, rows: [] })

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({
      posthogConfigured: true,
      posthogConnected: false,
      posthogFailureReason: 'unavailable',
    })
  })

  it('retains exact rows while failing closed on URL-looking legacy rows and reporting unmatched data', async () => {
    expect(LEGACY_PATH_SOURCE).toBe('unavailable')
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([
        behavior(),
        behavior({ timestamp_ms: startMs + 120_000, org_id: ORG_B, page: '', distinct_id: 'user-b', event_current_url: 42, event_pathname: {}, person_current_url: [] }),
        behavior({ timestamp_ms: startMs + 180_000, org_id: '', grouped_org_id: '', distinct_id: 'user-c' }),
        behavior({ timestamp_ms: startMs + 300_000, event: 'Checkout Started' }),
        behavior({ timestamp_ms: startMs + 360_000, event: 'Checkout Started', org_id: 'not-a-uuid', grouped_org_id: '', distinct_id: 'user-invalid-checkout' }),
        behavior({ timestamp_ms: startMs + 420_000, event: 'Checkout Started', org_id: 42, grouped_org_id: null, distinct_id: 'user-wrong-type-checkout' }),
        behavior({ timestamp_ms: startMs + 480_000, event: 'Checkout Started', org_id: undefined, grouped_org_id: '', distinct_id: 'user-missing-checkout' }),
        behavior({ timestamp_ms: startMs + 7_200_000, event: 'Checkout Started', org_id: ORG_X, distinct_id: 'user-x' }),
        behavior({ timestamp_ms: startMs - 1, event: 'Checkout Started', org_id: '', grouped_org_id: '', distinct_id: 'user-before-window' }),
        behavior({ timestamp_ms: Date.parse(end) + 24 * 60 * 60 * 1000, event: 'Checkout Started', org_id: '', grouped_org_id: '', distinct_id: 'user-after-window' }),
      ]))
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce(connected([{ exact_tracking_started_at: '2026-08-01T10:00:00Z' }]))
    vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map([[ORG_A, history(ORG_A)]]))

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.dataQuality).toMatchObject({
      exactTrackingStartedAt: '2026-08-01T10:00:00.000Z',
      exactLogicalOpens: 1,
      legacyLogicalOpens: 0,
      legacyReconstructionAvailable: false,
      legacyUnavailableReason: 'missing_event_time_path',
      excludedMissingOrganization: 4,
      unmatchedCheckoutStarts: 1,
      unknownBillingOrganizations: 0,
      legacyDeduplicationSeconds: null,
    })
    expect(result.traffic.totalOpens).toEqual([1])
    expect(result.checkoutIntent[0]).toMatchObject({ startedCheckout: 1, didNotStart: 0 })
  })

  it('uses grouped organization fallback, exact range boundaries, and excludes invalid scalar rows safely', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([
        behavior({ timestamp_ms: startMs, org_id: 'not-a-uuid', grouped_org_id: ` ${ORG_GROUPED.toUpperCase()} ` }),
        behavior({ timestamp_ms: Date.parse(end), org_id: ORG_X }),
        behavior({ timestamp_ms: Number.NaN, org_id: ORG_X }),
        behavior({ timestamp_ms: startMs + 1, event: ['User visit'], org_id: ORG_X }),
        behavior({ timestamp_ms: startMs + 2, org_id: 12 }),
        behavior({ timestamp_ms: startMs + 3, org_id: '  ', grouped_org_id: '', page: 'plans' }),
        behavior({ timestamp_ms: startMs + 4, org_id: 'not-a-uuid', grouped_org_id: null, page: 'plans' }),
        behavior({ timestamp_ms: startMs + 5, org_id: undefined, grouped_org_id: {}, page: 'plans' }),
      ]))
      .mockResolvedValueOnce(connected([
        { timestamp_ms: startMs, event: 'User subscribe', group_key: ORG_GROUPED, group_type: 'organization', grouped_org_id: '', plan_status: 'succeeded', canceled_at: null },
        { timestamp_ms: 'invalid', event: 'User cancel', group_key: ORG_GROUPED, group_type: 'organization', grouped_org_id: '', plan_status: 'canceled', canceled_at: '2026-08-01T01:00:00Z' },
      ]))
      .mockResolvedValueOnce(connected([{ exact_tracking_started_at: 42 }]))
    vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map([[ORG_GROUPED, history(ORG_GROUPED)]]))

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.traffic).toEqual({ dates: ['2026-08-01'], uniqueVisitorOrganizations: [1], totalOpens: [1] })
    expect(result.dataQuality).toMatchObject({ exactTrackingStartedAt: null, exactLogicalOpens: 1, excludedMissingOrganization: 4 })
    expect(loadPlansBillingHistories).toHaveBeenCalledWith(
      context,
      [ORG_GROUPED],
      '2026-08-01',
      '2026-08-02',
      new Map([[ORG_GROUPED, [{ timestampMs: startMs, kind: 'paid' }]]]),
    )
  })

  it('integrates transition mapping, billing loading, and historical classification', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([
        behavior({ org_id: ORG_PAID }),
        behavior({ timestamp_ms: startMs + 120_000, org_id: ORG_CANCELED, distinct_id: 'user-b' }),
      ]))
      .mockResolvedValueOnce(connected([
        { timestamp_ms: startMs - 5_000, event: 'User subscribe', group_key: ORG_PAID, group_type: 'organization', grouped_org_id: '', plan_status: 'succeeded', canceled_at: null },
        { timestamp_ms: startMs - 5_000, event: 'User cancel', group_key: '', group_type: '', grouped_org_id: ORG_CANCELED, plan_status: 'canceled', canceled_at: '2026-07-31T23:59:55Z' },
      ]))
      .mockResolvedValueOnce(connected())
    vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map([
      [ORG_PAID, history(ORG_PAID, { paidAtMs: startMs - 5_000 })],
      [ORG_CANCELED, history(ORG_CANCELED, {
        trialEndsAtMs: startMs - 200_000,
        paidAtMs: startMs - 100_000,
        canceledAtMs: startMs - 5_000,
      })],
    ]))

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(loadPlansBillingHistories).toHaveBeenCalledWith(
      context,
      [ORG_PAID, ORG_CANCELED],
      '2026-08-01',
      '2026-08-02',
      new Map([
        [ORG_PAID, [{ timestampMs: startMs - 5_000, kind: 'paid' }]],
        [ORG_CANCELED, [{ timestampMs: startMs - 5_000, kind: 'canceled' }]],
      ]),
    )
    expect(result.visitorBreakdown[0]).toMatchObject({ paying: 1, canceled: 1, total: 2 })
  })

  it('ignores bare updates and maps only trustworthy explicit billing states', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([
        behavior(),
        behavior({ org_id: ORG_B, distinct_id: 'user-b' }),
        behavior({ org_id: ORG_C, distinct_id: 'user-c' }),
        behavior({ org_id: ORG_D, distinct_id: 'user-d' }),
        behavior({ org_id: ORG_E, distinct_id: 'user-e' }),
        behavior({ org_id: ORG_F, distinct_id: 'user-f' }),
      ]))
      .mockResolvedValueOnce(connected([
        { timestamp_ms: startMs - 6_000, event: 'User update subscribe', group_key: '', group_type: '', grouped_org_id: ORG_A, plan_status: 'past_due', event_plan_status: null, canceled_at: null },
        { timestamp_ms: startMs - 5_000, event: '$groupidentify', group_key: ORG_A, group_type: 'organization', grouped_org_id: '', plan_status: 'past_due', event_plan_status: null, canceled_at: null },
        { timestamp_ms: startMs - 4_000, event: 'User update subscribe', group_key: '', group_type: '', grouped_org_id: ORG_B, plan_status: null, event_plan_status: null, canceled_at: null },
        { timestamp_ms: startMs - 3_000, event: 'User update subscribe', group_key: '', group_type: '', grouped_org_id: ORG_C, plan_status: null, event_plan_status: 'succeeded', canceled_at: null },
        { timestamp_ms: startMs - 2_000, event: 'User update subscribe', group_key: '', group_type: '', grouped_org_id: ORG_D, plan_status: null, event_plan_status: 'mystery', canceled_at: null },
        { timestamp_ms: startMs - 1_000, event: '$groupidentify', group_key: ORG_E, group_type: 'organization', grouped_org_id: '', plan_status: null, event_plan_status: null, canceled_at: '2026-07-31T23:59:59Z' },
        { timestamp_ms: startMs - 500, event: '$groupidentify', group_key: ORG_F, group_type: 'organization', grouped_org_id: '', plan_status: 'succeeded', event_plan_status: null, canceled_at: null },
      ]))
      .mockResolvedValueOnce(connected())

    await getAdminPlansAnalytics(context, start, end)

    expect(vi.mocked(loadPlansBillingHistories).mock.calls[0]?.[4]).toEqual(new Map([
      [ORG_A, [{ timestampMs: startMs - 5_000, kind: 'payment_problem' }]],
      [ORG_C, [{ timestampMs: startMs - 3_000, kind: 'paid' }]],
      [ORG_E, [{ timestampMs: startMs - 1_000, kind: 'canceled' }]],
      [ORG_F, [{ timestampMs: startMs - 500, kind: 'paid' }]],
    ]))
  })

  it('keeps a same-second future cancellation from applying retroactively', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([behavior({ timestamp_ms: startMs + 100 })]))
      .mockResolvedValueOnce(connected([
        { timestamp_ms: startMs + 200, event: 'User cancel', group_key: '', group_type: '', grouped_org_id: ORG_A, plan_status: null, event_plan_status: null, canceled_at: null },
      ]))
      .mockResolvedValueOnce(connected())
    vi.mocked(loadPlansBillingHistories).mockImplementation(async (_context, orgIds, _startDate, _endDate, transitions) => new Map([
      [ORG_A, history(ORG_A, {
        trialEndsAtMs: startMs - 10_000,
        paidAtMs: startMs - 1_000,
        transitions: transitions.get(ORG_A) ?? [],
      })],
    ].filter(([orgId]) => orgIds.includes(orgId as string)) as Array<[string, OrganizationBillingHistory]>))

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.visitorBreakdown[0]).toMatchObject({ paying: 1, canceled: 0, total: 1 })
  })

  it('maps a representative invalid-row payload without returning partial charts', async () => {
    const invalidRows = Array.from({ length: 5_000 }, (_, index) => behavior({
      timestamp_ms: startMs + index,
      org_id: index % 2 === 0 ? `invalid-${index}` : index,
      grouped_org_id: index % 3 === 0 ? {} : '',
      event_current_url: index,
    }))
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([...invalidRows, behavior({ timestamp_ms: startMs + 10_000 })]))
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce(connected())

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.traffic.totalOpens).toEqual([1])
    expect(result.dataQuality).toMatchObject({ exactLogicalOpens: 1, excludedMissingOrganization: 5_000, posthogFailureReason: null })
  })

  it('counts unknown billing organizations uniquely across visitor and checkout chart populations', async () => {
    vi.mocked(queryPosthogHogql)
      .mockResolvedValueOnce(connected([
        behavior({ org_id: ORG_KNOWN }),
        behavior({ timestamp_ms: startMs + 120_000, org_id: ORG_UNKNOWN, distinct_id: 'user-b' }),
        behavior({ timestamp_ms: startMs + 180_000, event: 'Checkout Started', org_id: ORG_UNKNOWN, distinct_id: 'user-b' }),
      ]))
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce(connected())
    vi.mocked(loadPlansBillingHistories).mockResolvedValue(new Map([[ORG_KNOWN, history(ORG_KNOWN)]]))

    const result = await getAdminPlansAnalytics(context, start, end)

    expect(result.visitorBreakdown[0]).toMatchObject({ activeTrial: 1, unknown: 1, total: 2 })
    expect(result.checkoutVisitorBreakdown[0]).toMatchObject({ unknown: 1, total: 1 })
    expect(result.dataQuality.unknownBillingOrganizations).toBe(1)
  })

  it.each([
    ['invalid start', 'not-a-date', end],
    ['invalid end', start, 'not-a-date'],
    ['equal dates', start, start],
    ['reversed dates', end, start],
    ['end outside the safe attribution range', start, '+275760-09-12T23:59:59.999Z'],
  ])('returns a deterministic empty response for %s without querying', async (_label, invalidStart, invalidEnd) => {
    const first = await getAdminPlansAnalytics(context, invalidStart, invalidEnd)
    const second = await getAdminPlansAnalytics(context, invalidStart, invalidEnd)

    expect(first).toEqual(second)
    expect(first.traffic).toEqual({ dates: [], uniqueVisitorOrganizations: [], totalOpens: [] })
    expect(queryPosthogHogql).not.toHaveBeenCalled()
    expect(loadPlansBillingHistories).not.toHaveBeenCalled()
  })
})
