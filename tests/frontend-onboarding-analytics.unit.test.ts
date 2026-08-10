import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryPosthogHogqlMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({
  queryPosthogHogql: queryPosthogHogqlMock,
}))

import {
  buildFrontendOnboardingHogql,
  getAdminFrontendOnboardingAnalytics,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function createContext(): Context {
  return {} as Context
}

beforeEach(() => {
  queryPosthogHogqlMock.mockReset()
  queryPosthogHogqlMock.mockResolvedValue({
    configured: true,
    connected: true,
    failureReason: null,
    rows: [],
  })
})

describe('buildFrontendOnboardingHogql', () => {
  it('queries the fixed v1 pre-org viewed events grouped by attempt in an exclusive time range', () => {
    const query = buildFrontendOnboardingHogql('2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z')

    expect(query).toContain("event = 'onboarding_step_viewed'")
    expect(query).toContain("JSONExtractString(toString(properties), 'flow') = 'pre_org'")
    expect(query).toContain('toInt64OrZero(toString(properties.onboarding_version)) = 1')
    expect(query).toContain("JSONExtractString(toString(properties), 'onboarding_attempt_id')")
    expect(query).toContain("JSONExtractString(toString(properties), 'step')")
    expect(query).toContain("minIf(timestamp, step = 'intent')")
    expect(query).toContain("minIf(timestamp, step = 'details')")
    expect(query).toContain("minIf(timestamp, step = 'organization')")
    expect(query).toContain("minIf(timestamp, step = 'setup')")
    expect(query).toContain('GROUP BY attempt_id')
    expect(query).toContain("timestamp >= parseDateTimeBestEffort('2026-08-01T00:00:00.000Z')")
    expect(query).toContain("timestamp < parseDateTimeBestEffort('2026-08-04T00:00:00.000Z')")
    expect(query).toContain("trim(attempt_id) != ''")
    expect(query).toContain('HAVING intent_ms > 0')
  })
})

describe('getAdminFrontendOnboardingAnalytics', () => {
  it('maps a successful grouped row into frontend onboarding analytics', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const intentMs = Date.parse(start) + 60 * 60 * 1000
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        attempt_id: 'attempt-1',
        intent_ms: intentMs,
        details_ms: intentMs + 1_000,
        organization_ms: intentMs + 2_000,
        setup_ms: intentMs + 3_000,
      }],
    })

    const result = await getAdminFrontendOnboardingAnalytics(createContext(), start, '2026-08-03T00:00:00.000Z')

    expect(result).toMatchObject({
      onboarding_version: 1,
      kpis: { attempts: 1, completed: 1, completion_rate: 100 },
      daily_attempts: [
        { date: '2026-08-01', attempts: 1 },
        { date: '2026-08-02', attempts: 0 },
      ],
      funnel: [
        { key: 'intent', reached: 1 },
        { key: 'details', reached: 1 },
        { key: 'organization', reached: 1 },
        { key: 'setup', reached: 1 },
      ],
      posthog_configured: true,
      posthog_connected: true,
    })
  })

  it.each([
    { configured: false, connected: false, failureReason: 'unconfigured' },
    { configured: true, connected: false, failureReason: 'unavailable' },
  ])('returns zero analytics when PostHog is missing or unavailable while preserving connectivity', async (posthog) => {
    queryPosthogHogqlMock.mockResolvedValueOnce({ ...posthog, rows: [] })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).resolves.toMatchObject({
      kpis: { attempts: 0, completed: 0, completion_rate: 0 },
      posthog_configured: posthog.configured,
      posthog_connected: posthog.connected,
    })
  })

  it('skips invalid attempts and converts missing or invalid optional step timestamps to null', async () => {
    const startMs = Date.parse('2026-08-01T00:00:00.000Z')
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { attempt_id: '  ', intent_ms: startMs + 1_000, details_ms: startMs + 2_000 },
        { attempt_id: 'no-intent', intent_ms: null, details_ms: startMs + 2_000 },
        { attempt_id: 'not-finite', intent_ms: 'Infinity', details_ms: startMs + 2_000 },
        { attempt_id: 'zero-intent', intent_ms: 0, details_ms: startMs + 2_000 },
        { attempt_id: 'valid', intent_ms: startMs + 1_000, details_ms: undefined, organization_ms: 0, setup_ms: 'not-a-number' },
      ],
    })

    const result = await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      kpis: { attempts: 1, completed: 0, completion_rate: 0 },
      funnel: [
        { key: 'intent', reached: 1 },
        { key: 'details', reached: 0 },
        { key: 'organization', reached: 0 },
        { key: 'setup', reached: 0 },
      ],
    })
  })

  it('queries the equal-length previous window through the current end plus 24 hours', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const end = '2026-08-03T00:00:00.000Z'

    await getAdminFrontendOnboardingAnalytics(createContext(), start, end)

    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(1)
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${new Date(Date.parse(start) - 2 * DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `timestamp < parseDateTimeBestEffort('${new Date(Date.parse(end) + DAY_MS).toISOString()}')`,
    )
  })

  it.each([
    ['not-a-date', '2026-08-03T00:00:00.000Z'],
    ['2026-08-03T00:00:00.000Z', 'not-a-date'],
    ['2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'],
    ['2026-08-04T00:00:00.000Z', '2026-08-03T00:00:00.000Z'],
  ])('rejects invalid bounds before calling PostHog', async (start, end) => {
    await expect(getAdminFrontendOnboardingAnalytics(createContext(), start, end)).rejects.toBeInstanceOf(RangeError)
    expect(queryPosthogHogqlMock).not.toHaveBeenCalled()
  })
})
