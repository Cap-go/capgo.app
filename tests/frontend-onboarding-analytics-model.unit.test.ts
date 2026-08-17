import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingAnalytics,
  FRONTEND_ONBOARDING_FOLLOWUP_MS,
  FRONTEND_ONBOARDING_VERSIONS,
  type FrontendOnboardingAttempt,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const CURRENT_START_MS = Date.UTC(2026, 7, 1)
const CURRENT_END_MS = CURRENT_START_MS + 2 * DAY_MS

function attempt(overrides: Partial<FrontendOnboardingAttempt> & Pick<FrontendOnboardingAttempt, 'attemptId' | 'intentMs'>): FrontendOnboardingAttempt {
  return {
    onboardingVersion: 3,
    personId: overrides.attemptId,
    aiInstructionsCopiedMs: [],
    cliStartedMs: [],
    interactionEvents: [],
    detailsMs: null,
    organizationMs: null,
    setupMs: null,
    ...overrides,
  }
}

describe('buildFrontendOnboardingAnalytics', () => {
  it.concurrent('builds v3 KPIs, split daily attempts, and per-version monotonic funnels', () => {
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
      attempt({
        attemptId: 'v1-intent',
        intentMs: CURRENT_START_MS + DAY_MS,
        onboardingVersion: 1,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis).toMatchObject({
      attempts: 4,
      completed: 2,
      completion_rate: 50,
      median_completion_ms: 300_000,
      largest_dropoff: { from: 'details', to: 'organization', percentage: 1 / 3 * 100 },
    })
    expect(analytics.daily_attempts).toEqual([
      { date: '2026-08-01', v1_attempts: 0, v2_attempts: 0, v3_attempts: 2 },
      { date: '2026-08-02', v1_attempts: 1, v2_attempts: 0, v3_attempts: 2 },
    ])
    expect(analytics.funnels.v3.map(stage => stage.reached)).toEqual([4, 3, 2, 2])
    expect(analytics.funnels.v3).toEqual([
      { key: 'intent', label: 'Intent', reached: 4, of_start_percent: 100, dropoff_percent: 0 },
      { key: 'details', label: 'App details', reached: 3, of_start_percent: 75, dropoff_percent: 25 },
      { key: 'organization', label: 'Organization', reached: 2, of_start_percent: 50, dropoff_percent: 1 / 3 * 100 },
      { key: 'setup', label: 'Setup reached', reached: 2, of_start_percent: 50, dropoff_percent: 0 },
    ])
    expect(analytics.funnels.v1.map(stage => stage.reached)).toEqual([1, 0, 0, 0])
  })

  it.concurrent('builds range-level daily and v3-only de-duplicated variants', () => {
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'furthest-v1',
        personId: 'furthest',
        onboardingVersion: 1,
        intentMs: CURRENT_START_MS + MINUTE_MS,
        setupMs: CURRENT_START_MS + 2 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'furthest-v3',
        personId: 'furthest',
        intentMs: CURRENT_START_MS + DAY_MS + MINUTE_MS,
        organizationMs: CURRENT_START_MS + DAY_MS + 2 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'latest-v1',
        personId: 'latest',
        onboardingVersion: 1,
        intentMs: CURRENT_START_MS + 3 * MINUTE_MS,
        detailsMs: CURRENT_START_MS + 4 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'latest-v3',
        personId: 'latest',
        intentMs: CURRENT_START_MS + DAY_MS + 3 * MINUTE_MS,
        detailsMs: CURRENT_START_MS + DAY_MS + 4 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'blank-day-one',
        personId: '',
        intentMs: CURRENT_START_MS + 5 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'blank-day-two',
        personId: '',
        intentMs: CURRENT_START_MS + DAY_MS + 5 * MINUTE_MS,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.deduplicated.daily_attempts).toEqual([
      { date: '2026-08-01', v1_attempts: 1, v2_attempts: 0, v3_attempts: 1 },
      { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0, v3_attempts: 2 },
    ])
    expect(analytics.deduplicated.funnels.v3.map(stage => stage.reached)).toEqual([4, 2, 1, 0])
  })

  it.concurrent('keeps blank and namespaced person identities separate', () => {
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'blank-attempt',
        personId: '',
        onboardingVersion: 1,
        intentMs: CURRENT_START_MS,
      }),
      attempt({
        attemptId: 'real-person-attempt',
        personId: 'attempt:blank-attempt',
        intentMs: CURRENT_START_MS + MINUTE_MS,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.deduplicated.daily_attempts).toEqual([
      { date: '2026-08-01', v1_attempts: 1, v2_attempts: 0, v3_attempts: 1 },
      { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0, v3_attempts: 0 },
    ])
  })

  it.concurrent('ignores steps before intent and after the 24-hour progression window', () => {
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

    expect(analytics.funnels.v3.map(stage => stage.reached)).toEqual([1, 0, 0, 0])
    expect(analytics.kpis.median_completion_ms).toBeNull()
  })

  it.concurrent('uses the immediately preceding cohort for comparisons', () => {
    const previousStartMs = CURRENT_START_MS - 2 * DAY_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'previous-complete',
        intentMs: previousStartMs,
        setupMs: previousStartMs + 10 * MINUTE_MS,
      }),
      attempt({ attemptId: 'previous-intent-only', intentMs: previousStartMs + MINUTE_MS }),
      attempt({
        attemptId: 'previous-v1-intent-only',
        intentMs: previousStartMs + 2 * MINUTE_MS,
        onboardingVersion: 1,
      }),
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

  it.concurrent('returns null comparisons without a previous cohort denominator', () => {
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

  it.concurrent('returns zero KPIs, zero-filled days, and an empty funnel for an empty cohort', () => {
    const analytics = buildFrontendOnboardingAnalytics([], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.kpis).toMatchObject({
      attempts: 0,
      completed: 0,
      completion_rate: 0,
      median_completion_ms: null,
      largest_dropoff: null,
    })
    expect(analytics.daily_attempts).toEqual([
      { date: '2026-08-01', v1_attempts: 0, v2_attempts: 0, v3_attempts: 0 },
      { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0, v3_attempts: 0 },
    ])
    expect(analytics.funnels.v1.map(stage => stage.reached)).toEqual([0, 0, 0, 0])
    expect(analytics.funnels.v2.map(stage => stage.reached)).toEqual([0, 0, 0, 0])
    expect(analytics.funnels.v3.map(stage => stage.reached)).toEqual([0, 0, 0, 0])
    expect(analytics.v2_graph.nodes).toEqual([])
    expect(analytics.v3_graph.nodes).toEqual([])
  })

  it.concurrent('reports no largest drop-off when every attempt reaches every stage', () => {
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

  it.concurrent('includes the start boundary and 24-hour step boundary but excludes the end boundary', () => {
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

  it.concurrent('fills every UTC date crossed by a partial-day range', () => {
    const startMs = Date.UTC(2026, 7, 1, 23)
    const endMs = Date.UTC(2026, 7, 2, 1)
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({ attemptId: 'late-day-one', intentMs: startMs }),
      attempt({ attemptId: 'early-day-two', intentMs: startMs + 90 * MINUTE_MS }),
    ], startMs, endMs)

    expect(analytics.daily_attempts).toEqual([
      { date: '2026-08-01', v1_attempts: 0, v2_attempts: 0, v3_attempts: 1 },
      { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0, v3_attempts: 1 },
    ])
  })

  it.concurrent('builds daily stage conversions with the funnel version rules and source-stage dates', () => {
    const dayOneDetailsMs = CURRENT_START_MS + 23 * 60 * MINUTE_MS
    const dayTwoOrganizationMs = CURRENT_START_MS + DAY_MS + MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'v3-crosses-midnight',
        intentMs: CURRENT_START_MS + 12 * 60 * MINUTE_MS,
        detailsMs: dayOneDetailsMs,
        organizationMs: dayTwoOrganizationMs,
        setupMs: dayTwoOrganizationMs + MINUTE_MS,
      }),
      attempt({
        attemptId: 'v1-converts-first-transition',
        onboardingVersion: 1,
        intentMs: CURRENT_START_MS + MINUTE_MS,
        detailsMs: CURRENT_START_MS + 2 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'v1-does-not-enter-later-series',
        onboardingVersion: 1,
        intentMs: CURRENT_START_MS + 3 * MINUTE_MS,
        detailsMs: CURRENT_START_MS + 4 * MINUTE_MS,
        organizationMs: CURRENT_START_MS + 5 * MINUTE_MS,
        setupMs: CURRENT_START_MS + 6 * MINUTE_MS,
      }),
      attempt({ attemptId: 'intent-only', intentMs: CURRENT_START_MS + 5 * MINUTE_MS }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.daily_conversions).toEqual({
      intent_to_details: [
        { date: '2026-08-01', started: 4, converted: 3, conversion_percent: 75 },
        { date: '2026-08-02', started: 0, converted: 0, conversion_percent: null },
      ],
      details_to_organization: [
        { date: '2026-08-01', started: 1, converted: 1, conversion_percent: 100 },
        { date: '2026-08-02', started: 0, converted: 0, conversion_percent: null },
      ],
      organization_to_setup: [
        { date: '2026-08-01', started: 0, converted: 0, conversion_percent: null },
        { date: '2026-08-02', started: 1, converted: 1, conversion_percent: 100 },
      ],
    })
  })

  it.concurrent('uses monotonic stage reach and the inclusive 24-hour window in daily conversions', () => {
    const intentMs = CURRENT_START_MS + MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'setup-at-boundary',
        intentMs,
        setupMs: intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS,
      }),
      attempt({
        attemptId: 'setup-after-boundary',
        intentMs: intentMs + MINUTE_MS,
        setupMs: intentMs + MINUTE_MS + FRONTEND_ONBOARDING_FOLLOWUP_MS + 1,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.daily_conversions.intent_to_details[0]).toEqual({
      date: '2026-08-01',
      started: 2,
      converted: 1,
      conversion_percent: 50,
    })
    expect(analytics.daily_conversions.details_to_organization[1]).toEqual({
      date: '2026-08-02',
      started: 1,
      converted: 1,
      conversion_percent: 100,
    })
    expect(analytics.daily_conversions.organization_to_setup[1]).toEqual({
      date: '2026-08-02',
      started: 1,
      converted: 1,
      conversion_percent: 100,
    })
  })

  it.concurrent('includes pre-range intents when their later source stage is inside the selected range', () => {
    const intentMs = CURRENT_START_MS - MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'details-enter-range',
        intentMs,
        detailsMs: CURRENT_START_MS,
        organizationMs: CURRENT_START_MS + MINUTE_MS,
        setupMs: CURRENT_START_MS + 2 * MINUTE_MS,
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.daily_conversions.intent_to_details[0].started).toBe(0)
    expect(analytics.daily_conversions.details_to_organization[0]).toEqual({
      date: '2026-08-01',
      started: 1,
      converted: 1,
      conversion_percent: 100,
    })
    expect(analytics.daily_conversions.organization_to_setup[0]).toEqual({
      date: '2026-08-01',
      started: 1,
      converted: 1,
      conversion_percent: 100,
    })
  })

  it.concurrent('keeps the median comparison null when the previous cohort has no completions', () => {
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

  it.concurrent.each([
    ['equal bounds', CURRENT_START_MS, CURRENT_START_MS],
    ['reversed bounds', CURRENT_END_MS, CURRENT_START_MS],
    ['NaN start', Number.NaN, CURRENT_END_MS],
  ])('rejects %s', (_description, startMs, endMs) => {
    expect(() => buildFrontendOnboardingAnalytics([], startMs, endMs)).toThrow(RangeError)
  })

  it.concurrent('rejects an infinite end bound', () => {
    expect(() => buildFrontendOnboardingAnalytics([], CURRENT_START_MS, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it.concurrent('counts each current v3 interaction event once and ignores older-version events', () => {
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'v3-repeated-events',
        intentMs: CURRENT_START_MS,
        interactionEvents: [
          { key: 'organization_created', timestampMs: CURRENT_START_MS + MINUTE_MS },
          { key: 'organization_created', timestampMs: CURRENT_START_MS + 2 * MINUTE_MS },
          { key: 'app_created', timestampMs: CURRENT_START_MS + 3 * MINUTE_MS },
        ],
      }),
      attempt({
        attemptId: 'v3-shared-event',
        intentMs: CURRENT_START_MS + MINUTE_MS,
        interactionEvents: [{ key: 'organization_created', timestampMs: CURRENT_START_MS + 2 * MINUTE_MS }],
      }),
      attempt({
        attemptId: 'v1-ignored-event',
        intentMs: CURRENT_START_MS + 2 * MINUTE_MS,
        onboardingVersion: 1,
        interactionEvents: [
          { key: 'v1_only_event', timestampMs: CURRENT_START_MS + 3 * MINUTE_MS },
          { key: 'organization_created', timestampMs: CURRENT_START_MS + 3 * MINUTE_MS },
        ],
      }),
      attempt({
        attemptId: 'previous-v3-event',
        intentMs: CURRENT_START_MS - DAY_MS,
        interactionEvents: [{ key: 'previous_event', timestampMs: CURRENT_START_MS - DAY_MS + MINUTE_MS }],
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(FRONTEND_ONBOARDING_VERSIONS).toEqual([1, 2, 3])
    expect(analytics.v3_graph.nodes).toEqual([
      { key: 'app_created', count: 1 },
      { key: 'organization_created', count: 2 },
    ])
  })

  it.concurrent('excludes interactions outside the same 24-hour attempt window as funnel progress', () => {
    const intentMs = CURRENT_START_MS + MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'windowed-interactions',
        intentMs,
        detailsMs: intentMs + MINUTE_MS,
        interactionEvents: [
          { key: 'before_intent', timestampMs: intentMs - 1 },
          { key: 'at_boundary', timestampMs: intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS },
          { key: 'after_boundary', timestampMs: intentMs + FRONTEND_ONBOARDING_FOLLOWUP_MS + 1 },
        ],
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.funnels.v3.find(stage => stage.key === 'details')?.reached).toBe(1)
    expect(analytics.v3_graph.nodes).toEqual([{ key: 'at_boundary', count: 1 }])
  })

  it.concurrent('classifies each setup-reaching v2 or v3 person once across mutually exclusive CLI outcomes', () => {
    const setupMs = CURRENT_START_MS + 10 * MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'cli-only',
        onboardingVersion: 2,
        personId: 'person-cli-only',
        intentMs: CURRENT_START_MS,
        setupMs,
        cliStartedMs: [setupMs + MINUTE_MS],
      }),
      attempt({
        attemptId: 'cli-and-ai-first-attempt',
        onboardingVersion: 2,
        personId: 'person-cli-and-ai',
        intentMs: CURRENT_START_MS + MINUTE_MS,
        setupMs: setupMs + MINUTE_MS,
        aiInstructionsCopiedMs: [setupMs + 2 * MINUTE_MS],
      }),
      attempt({
        attemptId: 'cli-and-ai-second-attempt',
        onboardingVersion: 3,
        personId: 'person-cli-and-ai',
        intentMs: CURRENT_START_MS + 2 * MINUTE_MS,
        setupMs: setupMs + 2 * MINUTE_MS,
        cliStartedMs: [setupMs + 3 * MINUTE_MS],
      }),
      attempt({
        attemptId: 'v3-cli-only',
        onboardingVersion: 3,
        personId: 'person-v3-cli-only',
        intentMs: CURRENT_START_MS + 3 * MINUTE_MS,
        setupMs: setupMs + 3 * MINUTE_MS,
        cliStartedMs: [setupMs + 4 * MINUTE_MS],
      }),
      attempt({
        attemptId: 'no-cli',
        onboardingVersion: 2,
        personId: 'person-no-cli',
        intentMs: CURRENT_START_MS + 4 * MINUTE_MS,
        setupMs: setupMs + 4 * MINUTE_MS,
      }),
      attempt({
        attemptId: 'ai-without-cli',
        onboardingVersion: 2,
        personId: 'person-ai-without-cli',
        intentMs: CURRENT_START_MS + 5 * MINUTE_MS,
        setupMs: setupMs + 5 * MINUTE_MS,
        aiInstructionsCopiedMs: [setupMs + 6 * MINUTE_MS],
      }),
      attempt({
        attemptId: 'v1-ignored',
        personId: 'person-v1',
        onboardingVersion: 1,
        intentMs: CURRENT_START_MS + 6 * MINUTE_MS,
        setupMs: setupMs + 6 * MINUTE_MS,
        cliStartedMs: [setupMs + 7 * MINUTE_MS],
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.v2_v3_setup_cli_outcomes).toEqual({
      total_users: 5,
      cli_only: 2,
      cli_and_ai_instructions: 1,
      no_cli: 2,
    })
  })

  it.concurrent('ignores CLI and AI signals outside the 24 hours after setup', () => {
    const setupMs = CURRENT_START_MS + MINUTE_MS
    const analytics = buildFrontendOnboardingAnalytics([
      attempt({
        attemptId: 'windowed-outcomes',
        onboardingVersion: 2,
        personId: 'person-windowed',
        intentMs: CURRENT_START_MS,
        setupMs,
        cliStartedMs: [setupMs - 1, setupMs + FRONTEND_ONBOARDING_FOLLOWUP_MS + 1],
        aiInstructionsCopiedMs: [setupMs + FRONTEND_ONBOARDING_FOLLOWUP_MS + 1],
      }),
      attempt({
        attemptId: 'boundary-outcomes',
        onboardingVersion: 2,
        personId: 'person-boundary',
        intentMs: CURRENT_START_MS + MINUTE_MS,
        setupMs: setupMs + MINUTE_MS,
        cliStartedMs: [setupMs + MINUTE_MS + FRONTEND_ONBOARDING_FOLLOWUP_MS],
        aiInstructionsCopiedMs: [setupMs + MINUTE_MS],
      }),
      attempt({
        attemptId: 'no-setup',
        onboardingVersion: 2,
        personId: 'person-no-setup',
        intentMs: CURRENT_START_MS + 2 * MINUTE_MS,
        cliStartedMs: [setupMs + 3 * MINUTE_MS],
      }),
    ], CURRENT_START_MS, CURRENT_END_MS)

    expect(analytics.v2_v3_setup_cli_outcomes).toEqual({
      total_users: 2,
      cli_only: 0,
      cli_and_ai_instructions: 1,
      no_cli: 1,
    })
  })
})
