import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertFrontendOnboardingAttemptTotal,
  buildFrontendOnboardingHogql,
  FRONTEND_ONBOARDING_ATTEMPT_LIMIT,
  FRONTEND_ONBOARDING_MAX_RANGE_MS,
  getAdminFrontendOnboardingAnalytics,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics.ts'

const { cloudlogErrMock, queryPosthogHogqlMock } = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  queryPosthogHogqlMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/posthog_read.ts', () => ({
  queryPosthogHogql: queryPosthogHogqlMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: cloudlogErrMock,
}))

const DAY_MS = 24 * 60 * 60 * 1000

function createContext(): Context {
  return { get: () => 'request-id' } as unknown as Context
}

beforeEach(() => {
  cloudlogErrMock.mockReset()
  queryPosthogHogqlMock.mockReset()
  queryPosthogHogqlMock.mockResolvedValue({
    configured: true,
    connected: true,
    failureReason: null,
    rows: [],
  })
})

describe('buildFrontendOnboardingHogql', () => {
  it('queries the fixed v2 pre-org viewed events grouped by attempt in an exclusive time range', () => {
    const query = buildFrontendOnboardingHogql(
      '2026-08-01T00:00:00.123Z',
      '2026-08-03T00:00:00.456Z',
      '2026-08-04T00:00:00.789Z',
    )

    expect(query).toContain('event = \'onboarding_step_viewed\'')
    expect(query).toContain('JSONExtractString(toString(properties), \'flow\') = \'pre_org\'')
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) = 2')
    expect(query).not.toContain('toInt64OrZero')
    expect(query).toContain('JSONExtractString(toString(properties), \'onboarding_attempt_id\')')
    expect(query).toContain('JSONExtractString(toString(properties), \'step\')')
    expect(query).not.toMatch(/WITH\s+JSONExtractString/)
    expect(query).toContain('FROM (\n      SELECT\n        timestamp,')
    expect(query).toContain(')\n    WHERE trim(attempt_id) != \'\'')
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, step = \'intent\'))')
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, step = \'details\'))')
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, step = \'organization\'))')
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, step = \'setup\'))')
    expect(query).toContain('GROUP BY attempt_id')
    expect(query).toContain('timestamp >= parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\')')
    expect(query).toContain('timestamp < parseDateTimeBestEffort(\'2026-08-04T00:00:00.789Z\')')
    expect(query).toContain('trim(attempt_id) != \'\'')
    expect(query).toContain('HAVING intent_ms >= toUnixTimestamp64Milli(parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\'))')
    expect(query).toContain('AND intent_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort(\'2026-08-03T00:00:00.456Z\'))')
    expect(query).not.toContain('parseDateTime64BestEffort')
    expect(query).toContain('ORDER BY intent_ms ASC, attempt_id ASC')
    expect(query).toContain('count() OVER () AS total_attempts')
    expect(query).toContain('LIMIT 50000')
    expect(query).not.toContain('LIMIT 50001')
  })
})

describe('assertFrontendOnboardingAttemptTotal', () => {
  it('fails closed when grouped total metadata exceeds its limit', () => {
    expect(() => assertFrontendOnboardingAttemptTotal(2, 1)).toThrow('frontend onboarding analytics query exceeded attempt limit')
    expect(() => assertFrontendOnboardingAttemptTotal(1, 1)).not.toThrow()
    expect(FRONTEND_ONBOARDING_ATTEMPT_LIMIT).toBe(50_000)
  })
})

describe('getAdminFrontendOnboardingAnalytics', () => {
  it('maps a successful grouped row into frontend onboarding analytics', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const intentMs = Date.parse(start) + 60 * 60 * 1000 + 123
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        attempt_id: 'attempt-1',
        intent_ms: intentMs,
        details_ms: intentMs + 555,
        organization_ms: intentMs + 1_000,
        setup_ms: intentMs + 2_666,
        total_attempts: 1,
      }],
    })

    const result = await getAdminFrontendOnboardingAnalytics(createContext(), start, '2026-08-03T00:00:00.000Z')

    expect(result).toMatchObject({
      onboarding_version: 2,
      kpis: { attempts: 1, completed: 1, completion_rate: 100, median_completion_ms: 2_666 },
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

  it('returns zero analytics for a successful PostHog query with no matching attempts', async () => {
    const result = await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      kpis: { attempts: 0, completed: 0, completion_rate: 0 },
      posthog_configured: true,
      posthog_connected: true,
    })
  })

  it.each([
    { configured: false, connected: true, failureReason: null },
    { configured: true, connected: false, failureReason: null },
    { configured: false, connected: false, failureReason: 'unconfigured' },
    { configured: true, connected: false, failureReason: 'unavailable' },
    { configured: true, connected: false, failureReason: 'timeout' },
    { configured: true, connected: true, failureReason: 'too_large' },
  ])('fails instead of reporting zero analytics for configured=$configured, connected=$connected, failureReason=$failureReason', async (posthog) => {
    queryPosthogHogqlMock.mockResolvedValueOnce({ ...posthog, rows: [] })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('frontend onboarding analytics PostHog query failed')
  })

  it('skips invalid attempts and converts missing or invalid optional step timestamps to null', async () => {
    const startMs = Date.parse('2026-08-01T00:00:00.000Z')
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { attempt_id: '  ', intent_ms: startMs + 1_000, details_ms: startMs + 2_000, total_attempts: 8 },
        { attempt_id: 'no-intent', intent_ms: null, details_ms: startMs + 2_000, total_attempts: 8 },
        { attempt_id: 'not-finite', intent_ms: 'Infinity', details_ms: startMs + 2_000, total_attempts: 8 },
        { attempt_id: 'zero-intent', intent_ms: 0, details_ms: startMs + 2_000, total_attempts: 8 },
        { attempt_id: false, intent_ms: startMs + 1_000, details_ms: startMs + 2_000, total_attempts: 8 },
        { attempt_id: ['array'], intent_ms: startMs + 1_000, details_ms: startMs + 2_000, total_attempts: 8 },
        { attempt_id: 'boolean-step', intent_ms: startMs + 2_000, details_ms: true, organization_ms: [], setup_ms: {}, total_attempts: 8 },
        { attempt_id: 'valid', intent_ms: String(startMs + 1_000), details_ms: undefined, organization_ms: 0, setup_ms: 'not-a-number', total_attempts: 8 },
      ],
    })

    const result = await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      kpis: { attempts: 2, completed: 0, completion_rate: 0 },
      funnel: [
        { key: 'intent', reached: 2 },
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
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `AND intent_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort('${end}'))`,
    )
  })

  it('accepts schema-valid sub-millisecond ISO fractions and normalizes them for PostHog', async () => {
    await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.1234Z',
      '2026-08-03T00:00:00.5678Z',
    )

    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(1)
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain('parseDateTimeBestEffort(\'2026-08-03T00:00:00.567Z\')')
  })

  it('rejects date ranges wider than the dashboard maximum before querying PostHog', async () => {
    const start = Date.UTC(2025, 0, 1)
    const end = start + FRONTEND_ONBOARDING_MAX_RANGE_MS + 1

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      new Date(start).toISOString(),
      new Date(end).toISOString(),
    )).rejects.toThrow('frontend onboarding analytics date range cannot exceed 365 days')
    expect(queryPosthogHogqlMock).not.toHaveBeenCalled()
  })

  it('logs and fails closed when PostHog exceeds the explicit attempt limit', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ total_attempts: FRONTEND_ONBOARDING_ATTEMPT_LIMIT + 1 }],
    })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('frontend onboarding analytics query exceeded attempt limit')
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'frontend_onboarding_analytics_attempt_limit_exceeded',
      attempt_limit: FRONTEND_ONBOARDING_ATTEMPT_LIMIT,
      total_attempts: FRONTEND_ONBOARDING_ATTEMPT_LIMIT + 1,
    }))
  })

  it('logs and rejects malformed grouped total metadata before aggregation', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ total_attempts: 'not-a-number' }],
    })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('frontend onboarding analytics query returned invalid total metadata')
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'frontend_onboarding_analytics_invalid_total_attempts',
    }))
  })

  it.each([
    ['not-a-date', '2026-08-03T00:00:00.000Z'],
    ['2026-08-03T00:00:00.000Z', 'not-a-date'],
    ['2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'],
    ['2026-08-04T00:00:00.000Z', '2026-08-03T00:00:00.000Z'],
    ['2026-02-30T00:00:00.000Z', '2026-03-03T00:00:00.000Z'],
    ['1969-12-30T00:00:00.000Z', '1970-01-01T00:00:00.000Z'],
    ['1970-01-01T00:00:00.000Z', '1970-01-02T00:00:00.000Z'],
    ['2105-12-31T00:00:00.000Z', '2106-01-01T00:00:00.000Z'],
    ['2105-12-30T00:00:00.000Z', '2105-12-31T00:00:00.000Z'],
  ])('rejects invalid bounds before calling PostHog', async (start, end) => {
    await expect(getAdminFrontendOnboardingAnalytics(createContext(), start, end)).rejects.toBeInstanceOf(RangeError)
    expect(queryPosthogHogqlMock).not.toHaveBeenCalled()
  })
})
