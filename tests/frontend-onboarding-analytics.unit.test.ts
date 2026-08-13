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
  it('queries v1 and v2 pre-org attempts, with stage timestamps limited to views and allowlisted v2 interactions', () => {
    const query = buildFrontendOnboardingHogql(
      '2026-08-01T00:00:00.123Z',
      '2026-08-03T00:00:00.456Z',
      '2026-08-04T00:00:00.789Z',
    )

    expect(query).toContain("event IN ('onboarding_step_viewed', 'onboarding_app_id_entered', 'onboarding_app_id_help_opened', 'onboarding_app_icon_picked', 'onboarding_app_icon_picker_closed_without_selection', 'onboarding_app_icon_picker_open_failed', 'onboarding_app_icon_picker_opened', 'onboarding_app_icon_upload_failed', 'onboarding_app_icon_uploaded', 'onboarding_app_name_entered', 'onboarding_store_import_failed', 'onboarding_store_import_hidden', 'onboarding_store_import_shown', 'onboarding_store_import_submitted', 'onboarding_store_import_succeeded', 'onboarding_store_url_entered')")
    expect(query).toContain('JSONExtractString(toString(properties), \'flow\') = \'pre_org\'')
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) AS onboarding_version')
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) IN (1, 2)')
    expect(query).not.toContain('toInt64OrZero')
    expect(query).toContain('JSONExtractString(toString(properties), \'onboarding_attempt_id\')')
    expect(query).toContain('JSONExtractString(toString(properties), \'step\')')
    expect(query).not.toMatch(/WITH\s+JSONExtractString/)
    expect(query).toContain('FROM (\n      SELECT\n        event,')
    expect(query).toContain(')\n    WHERE trim(attempt_id) != \'\'')
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'intent'))")
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'details'))")
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'organization'))")
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'setup'))")
    expect(query).toContain("groupUniqArrayIf(tuple(event, toUnixTimestamp64Milli(timestamp)), event != 'onboarding_step_viewed') AS interaction_events")
    expect(query).toContain('GROUP BY onboarding_version, attempt_id')
    expect(query).toContain('timestamp >= parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\')')
    expect(query).toContain('timestamp < parseDateTimeBestEffort(\'2026-08-04T00:00:00.789Z\')')
    expect(query).toContain('trim(attempt_id) != \'\'')
    expect(query).toContain('HAVING intent_ms >= toUnixTimestamp64Milli(parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\'))')
    expect(query).toContain('AND intent_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort(\'2026-08-03T00:00:00.456Z\'))')
    expect(query).not.toContain('parseDateTime64BestEffort')
    expect(query).toContain('ORDER BY intent_ms ASC, onboarding_version ASC, attempt_id ASC')
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
  it('maps grouped v1 and v2 rows, including repeated v2 interactions', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const intentMs = Date.parse(start) + 60 * 60 * 1000 + 123
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        attempt_id: 'attempt-1',
        onboarding_version: 2,
        intent_ms: intentMs,
        details_ms: intentMs + 555,
        organization_ms: intentMs + 1_000,
        setup_ms: intentMs + 2_666,
        interaction_events: [
          ['onboarding_app_id_entered', intentMs + 100],
          ['onboarding_app_id_entered', intentMs + 200],
        ],
        total_attempts: 2,
      }, {
        attempt_id: 'attempt-v1',
        onboarding_version: 1,
        intent_ms: intentMs + 1_000,
        interaction_events: [['onboarding_store_import_submitted', intentMs + 1_100]],
        total_attempts: 2,
      }],
    })

    const result = await getAdminFrontendOnboardingAnalytics(createContext(), start, '2026-08-03T00:00:00.000Z')

    expect(result).toMatchObject({
      kpis: { attempts: 1, completed: 1, completion_rate: 100, median_completion_ms: 2_666 },
      daily_attempts: [
        { date: '2026-08-01', v1_attempts: 1, v2_attempts: 1 },
        { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0 },
      ],
      funnels: { v2: [
        { key: 'intent', reached: 1 },
        { key: 'details', reached: 1 },
        { key: 'organization', reached: 1 },
        { key: 'setup', reached: 1 },
      ] },
      v2_graph: { nodes: [{ key: 'onboarding_app_id_entered', count: 1 }] },
      posthog_configured: true,
      posthog_connected: true,
    })
    expect(result).not.toHaveProperty('onboarding_version')
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

  it('skips invalid attempts, versions, and intents; maps malformed interactions to an empty list', async () => {
    const startMs = Date.parse('2026-08-01T00:00:00.000Z')
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { attempt_id: '  ', onboarding_version: 2, intent_ms: startMs + 1_000, details_ms: startMs + 2_000, total_attempts: 10 },
        { attempt_id: 'no-intent', onboarding_version: 2, intent_ms: null, details_ms: startMs + 2_000, total_attempts: 10 },
        { attempt_id: 'not-finite', onboarding_version: 2, intent_ms: 'Infinity', details_ms: startMs + 2_000, total_attempts: 10 },
        { attempt_id: 'zero-intent', onboarding_version: 2, intent_ms: 0, details_ms: startMs + 2_000, total_attempts: 10 },
        { attempt_id: false, onboarding_version: 2, intent_ms: startMs + 1_000, details_ms: startMs + 2_000, total_attempts: 10 },
        { attempt_id: ['array'], onboarding_version: 2, intent_ms: startMs + 1_000, details_ms: startMs + 2_000, total_attempts: 10 },
        { attempt_id: 'unknown-version', onboarding_version: 3, intent_ms: startMs + 1_000, total_attempts: 10 },
        { attempt_id: 'string-version', onboarding_version: '2', intent_ms: startMs + 1_000, total_attempts: 10 },
        { attempt_id: 'boolean-step', onboarding_version: 2, intent_ms: startMs + 2_000, details_ms: true, organization_ms: [], setup_ms: {}, interaction_events: 'not-an-array', total_attempts: 10 },
        { attempt_id: 'valid', onboarding_version: 2, intent_ms: String(startMs + 1_000), details_ms: undefined, organization_ms: 0, setup_ms: 'not-a-number', interaction_events: [[' valid ', startMs + 2_000], ['', startMs + 2_000], ['missing-time'], 42, null], total_attempts: 10 },
      ],
    })

    const result = await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      kpis: { attempts: 2, completed: 0, completion_rate: 0 },
      funnels: { v2: [
        { key: 'intent', reached: 2 },
        { key: 'details', reached: 0 },
        { key: 'organization', reached: 0 },
        { key: 'setup', reached: 0 },
      ] },
      v2_graph: { nodes: [{ key: 'valid', count: 1 }] },
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
