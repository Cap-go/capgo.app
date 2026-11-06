import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addBackfillRunTags, buildCheckpointResumeFilter, getBackfillProgressScopeKey, resolveCutoverIso } from '../scripts/backfill_credit_usage_posthog_events.ts'
import { buildCreditUsagePosthogEventInput } from '../supabase/functions/_backend/utils/credit_usage_posthog.ts'

const {
  queryJsonOneMock,
  trackPosthogEventMock,
} = vi.hoisted(() => ({
  queryJsonOneMock: vi.fn(),
  trackPosthogEventMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => next(),
  parseBody: async (c: { req: { json: () => Promise<unknown> } }) => await c.req.json(),
  simpleError: (code: string, message: string, info?: unknown) => {
    const error = new Error(`${code}: ${message}`)
    Object.assign(error, { info })
    return error
  },
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  trackPosthogEvent: trackPosthogEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getPgClient: vi.fn(async () => ({})),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  queryJsonOne: queryJsonOneMock,
}))

const transaction = {
  amount: -10,
  balance_after: 90,
  description: 'Overage deduction for build_time usage',
  grant_id: 'grant-1',
  id: 123,
  occurred_at: '2026-03-01T10:00:00.000Z',
  org_id: 'org-1',
  source_ref: { metric: 'build_time', overage_event_id: 'overage-1' },
  transaction_type: 'deduction',
}

const overageEvent = {
  billing_cycle_end: '2026-04-01',
  billing_cycle_start: '2026-03-01',
  created_at: '2026-03-01T10:00:00.000Z',
  credit_step_id: 7,
  credits_debited: 10,
  credits_estimated: 10,
  details: { limit: 3600, usage: 7200 },
  id: 'overage-1',
  metric: 'build_time',
  org_id: 'org-1',
  overage_amount: 3600,
}

function post(body: unknown) {
  return app.request(new Request('http://local/', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }))
}

const { app } = await import('../supabase/functions/_backend/triggers/credit_usage_posthog.ts')

beforeEach(() => {
  trackPosthogEventMock.mockResolvedValue(true)
  queryJsonOneMock.mockImplementation(async (_client: unknown, text: string) => {
    if (text.includes('public.usage_credit_transactions'))
      return transaction
    if (text.includes('public.usage_overage_events'))
      return overageEvent
    throw new Error(`Unexpected query ${text}`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  queryJsonOneMock.mockReset()
  trackPosthogEventMock.mockReset()
})

describe('credit usage PostHog event builder', () => {
  it('marks build-time deductions as credit spend linked to builds', () => {
    const input = buildCreditUsagePosthogEventInput(transaction as any, overageEvent as any, 'backfill')

    expect(input).toMatchObject({
      channel: 'usage',
      distinctId: 'org-1',
      event: 'Credit Usage Ledger Entry',
      groups: { organization: 'org-1' },
      timestamp: '2026-03-01T10:00:00.000Z',
    })
    expect(input.tags).toMatchObject({
      $insert_id: 'usage_credit_transaction:123',
      capture_source: 'backfill',
      credits_delta: -10,
      credits_spent: 10,
      is_build_time_credit_usage: true,
      metric: 'build_time',
      overage_event_id: 'overage-1',
      transaction_type: 'deduction',
      usage: 7200,
      limit: 3600,
    })
  })
})

describe('credit usage PostHog backfill helpers', () => {
  it('builds stable checkpoint scope keys', () => {
    expect(getBackfillProgressScopeKey(null)).toBe('all_orgs')
    expect(getBackfillProgressScopeKey(undefined)).toBe('all_orgs')
    expect(getBackfillProgressScopeKey(' org-1 ')).toBe('org:org-1')
  })

  it('builds a resume filter after the last processed occurred_at and id pair', () => {
    expect(buildCheckpointResumeFilter('2026-03-01T10:00:00.000Z', 123))
      .toBe('occurred_at.gt.2026-03-01T10:00:00.000Z,and(occurred_at.eq.2026-03-01T10:00:00.000Z,id.gt.123)')
  })

  it('normalizes explicit cutovers before they are used as query bounds', () => {
    expect(resolveCutoverIso({
      apply: true,
      configuredCutover: '2026-06-01',
      progress: null,
      to: new Date('2026-06-12T00:00:00.000Z'),
    })).toBe('2026-06-01T00:00:00.000Z')
  })

  it('requires a cutover before the first applying run', () => {
    expect(() => resolveCutoverIso({
      apply: true,
      configuredCutover: null,
      progress: null,
      to: new Date('2026-06-12T00:00:00.000Z'),
    })).toThrow('Missing cutover timestamp')
  })

  it('marks backfilled events with a run id without changing event identity', () => {
    const input = buildCreditUsagePosthogEventInput(transaction as any, overageEvent as any, 'backfill')

    const tagged = addBackfillRunTags(input, {
      backfillRangeFrom: '2026-03-01T00:00:00.000Z',
      backfillRangeTo: '2026-06-01T00:00:00.000Z',
      backfillRunId: 'credits-q2',
      backfillStartedAt: '2026-06-12T09:30:00.000Z',
    })

    expect(tagged).toBe(input)
    expect(tagged).toMatchObject({
      distinctId: 'org-1',
      event: 'Credit Usage Ledger Entry',
      timestamp: '2026-03-01T10:00:00.000Z',
    })
    expect(tagged.tags).toMatchObject({
      $insert_id: 'usage_credit_transaction:123',
      backfill_range_from: '2026-03-01T00:00:00.000Z',
      backfill_range_to: '2026-06-01T00:00:00.000Z',
      backfill_run_id: 'credits-q2',
      backfill_started_at: '2026-06-12T09:30:00.000Z',
      capture_source: 'backfill',
    })
  })
})

describe('credit usage PostHog trigger', () => {
  it('loads the transaction context and sends a PostHog-only event', async () => {
    const response = await post({ transaction_id: 123 })

    expect(response.status).toBe(200)
    expect(trackPosthogEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'Credit Usage Ledger Entry',
      groups: { organization: 'org-1' },
      setPersonProperties: false,
      timestamp: '2026-03-01T10:00:00.000Z',
      user_id: 'org-1',
      tags: expect.objectContaining({
        capture_source: 'backend',
        credits_spent: 10,
        is_build_time_credit_usage: true,
        metric: 'build_time',
        source_record_id: '123',
      }),
    }))
  })
})
