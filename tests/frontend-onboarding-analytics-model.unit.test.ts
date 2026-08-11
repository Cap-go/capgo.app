import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingAnalytics,
  FRONTEND_ONBOARDING_FOLLOWUP_MS,
  type FrontendOnboardingAttempt,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const CURRENT_START_MS = Date.UTC(2026, 7, 1)
const CURRENT_END_MS = CURRENT_START_MS + 2 * DAY_MS

function attempt(overrides: Partial<FrontendOnboardingAttempt> & Pick<FrontendOnboardingAttempt, 'attemptId' | 'intentMs'>): FrontendOnboardingAttempt {
  return {
    detailsMs: null,
    organizationMs: null,
    setupMs: null,
    ...overrides,
  }
}

describe('buildFrontendOnboardingAnalytics', () => {
  it('builds current KPIs, daily attempts, and a monotonic funnel', () => {
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'complete',
        intentMs: CURRENT_START_MS,
        detailsMs: CURRENT_START_MS + MINUTE_MS,
        organizationMs: CURRENT_START_MS + 2 * MINUTE_MS,
        setupMs: CURRENT_START_MS + 4 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'setup-only',
        intentMs: CURRENT_START_MS + MINUTE_MS,
        setupMs: CURRENT_START_MS + 7 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'details-only',
        intentMs: CURRENT_START_MS + DAY_MS,
        detailsMs: CURRENT_START_MS + DAY_MS + MINUTE_MS,
      }),
      attempt({ attemptId: 'intent-only', intentMs: CURRENT_START_MS + DAY_MS + MINUTE_MS }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis).toMatchObject({
      attempts: 4,
      completed: 2,
      completion_rate: 50,
      median_completion_ms: 300_000,
      largest_dropoff: { from: 'details', to: 'organization', percentage: 1 / 3 * 100 },
    })
    expect(analytics.daily_attempts).toEqual([
      { date: '2026-08-01', attempts: 2 },
      { date: '2026-08-02', attempts: 2 },
    ])
    expect(analytics.funnel.map(stage => stage.reached)).toEqual([4, 3, 2, 2])
    expect(analytics.funnel).toEqual([
      { key: 'intent', label: 'Intent', reached: 4, of_start_percent: 100, dropoff_percent: 0 },
      { key: 'details', label: 'App details', reached: 3, of_start_percent: 75, dropoff_percent: 25 },
      { key: 'organization', label: 'Organization', reached: 2, of_start_percent: 50, dropoff_percent: 1 / 3 * 100 },
      { key: 'setup', label: 'Setup reached', reached: 2, of_start_percent: 50, dropoff_percent: 0 },
    ])
  })

  it('ignores steps before intent and after the 24-hour progression window', () => {
    const intentMs = CURRENT_START_MS + MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'invalid-steps',
        intentMs,
        detailsMs: intentMs - 1,
        organizationMs: intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS + 1,
        setupMs: intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS + 1,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.funnel.map(stage => stage.reached)).toEqual([1, 0, 0, 0])
    expect(analytics.kpis.median_completion_ms).toBeNull()
  })

  it('uses the immediately preceding cohort for comparisons', () => {
    const previousStartMs = CURRENT_START_MS - 2 * DAY_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'previous-complete',
        intentMs: previousStartMs,
        setupMs: previousStartMs + 10 * MINUTE_MS,
      }),
      attempt({ attemptId: 'previous-intent-only', intentMs: previousStartMs + MINUTE_MS }),
      attempt({
        attemptId: 'current-complete-one',
        intentMs: CURRENT_START_MS,
        setupMs: CURRENT_START_MS + 4 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'current-complete-two',
        intentMs: CURRENT_START_MS + MINUTE_MS,
        setupMs: CURRENT_START_MS + 7 * MINUTE_MS,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis.comparison).toEqual({
      attempts_percent: 0,
      completion_rate_points: 50,
      median_completion_ms: -300_000,
      largest_dropoff_points: -50,
    })
  })

  it('returns null comparisons without a previous cohort denominator', () => {
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({ attemptId: 'current-intent', intentMs: CURRENT_START_MS }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis.comparison).toEqual({
      attempts_percent: null,
      completion_rate_points: null,
      median_completion_ms: null,
      largest_dropoff_points: null,
    })
  })

  it('returns zero KPIs, zero-filled days, and an empty funnel for an empty cohort', () => {
    const analytics = buildFrontendOnboardingAnalytics([], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis).toMatchObject({
      attempts: 0,
      completed: 0,
      completion_rate: 0,
      median_completion_ms: null,
      largest_dropoff: null,
    })
    expect(analytics.daily_attempts).toEqual([
      { date: '2026-08-01', attempts: 0 },
      { date: '2026-08-02', attempts: 0 },
    ])
    expect(analytics.funnel.map(stage => stage.reached)).toEqual([0, 0, 0, 0])
  })

  it('reports no largest drop-off when every attempt reaches every stage', () => {
    const previousStartMs = CURRENT_START_MS - 2 * DAY_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'previous-intent-only',
        intentMs: previousStartMs,
      }),
      attempt({
        attemptId: 'current-complete',
        intentMs: CURRENT_START_MS,
        setupMs: CURRENT_START_MS + MINUTE_MS,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis.largest_dropoff).toBeNull()
    expect(analytics.kpis.comparison.largest_dropoff_points).toBe(-100)
  })

  it('includes the start boundary and 24-hour step boundary but excludes the end boundary', () => {
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'start-inclusive',
        intentMs: CURRENT_START_MS,
        setupMs: CURRENT_START_MS + FRONTEND_ONBOARDING_FOLLOWUP_MS,
      }),
      attempt({ attemptId: 'end-exclusive', intentMs: CURRENT_END_MS }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis.attempts).toBe(1)
    expect(analytics.kpis.completed).toBe(1)
    expect(analytics.kpis.median_completion_ms).toBe(FRONTEND_ONBOARDING_FOLLOWUP_MS)
  })

  it('fills every UTC date crossed by a partial-day range', () => {
    const startMs = Date.UTC(2026, 7, 1, 23)
    const endMs = Date.UTC(2026, 7, 2, 1)
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({ attemptId: 'late-day-one', intentMs: startMs }),
      attempt({ attemptId: 'early-day-two', intentMs: startMs + 90 * MINUTE_MS }),
    ], startMs, endMs)

    expect(analytics.daily_attempts).toEqual([
      { date: '2026-08-01', attempts: 1 },
      { date: '2026-08-02', attempts: 1 },
    ])
  })

  it('keeps the median comparison null when the previous cohort has no completions', () => {
    const previousStartMs = CURRENT_START_MS - 2 * DAY_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({ attemptId: 'previous-intent-only', intentMs: previousStartMs }),
      attempt({
        attemptId: 'current-complete',
        intentMs: CURRENT_START_MS,
        setupMs: CURRENT_START_MS + 4 * MINUTE_MS,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis.comparison.median_completion_ms).toBeNull()
  })

  it.each([
    ['equal bounds', CURRENT_START_MS, CURRENT_START_MS],
    ['reversed bounds', CURRENT_END_MS, CURRENT_START_MS],
    ['NaN start', Number.NaN, CURRENT_END_MS],
  ])('rejects %s', (_description, startMs, endMs) => {
    expect(() => buildFrontendOnboardingAnalytics([], startMs, endMs)).toThrow(RangeError)
  })

  it('rejects an infinite end bound', () => {
    expect(() => buildFrontendOnboardingAnalytics([], CURRENT_START_MS, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})
