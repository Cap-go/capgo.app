import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertFrontendOnboardingAttemptTotal,
  buildFrontendOnboardingDailyTabSwitches,
  buildFrontendOnboardingHogql,
  buildFrontendOnboardingTabSwitchHogql,
  buildFrontendOnboardingWelcomeHogql,
  FRONTEND_ONBOARDING_ATTEMPT_LIMIT,
  FRONTEND_ONBOARDING_MAX_RANGE_MS,
  getAdminFrontendOnboardingAnalytics,
} from '../supabase/functions/_backend/utils/frontend_onboarding_analytics.ts'
import { buildFrontendOnboardingProductionHostHogql } from '../supabase/functions/_backend/utils/frontend_onboarding_analytics_model.ts'
import { createFrontendOnboardingDailySetupCliOutcomeCounts } from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts'

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

describe('buildFrontendOnboardingProductionHostHogql', () => {
  it('recovers missing-host production events only on August 22 UTC', () => {
    const filter = buildFrontendOnboardingProductionHostHogql('events.properties', 'events.timestamp')

    expect(filter).toContain('JSONExtractString(toString(events.properties), \'$host\') = \'console.capgo.app\'')
    expect(filter).toContain('isNull(events.properties[\'$host\'])')
    expect(filter).toContain('toDate(toTimeZone(events.timestamp, \'UTC\')) = toDate(\'2026-08-22\')')
    expect(filter).toContain('JSONExtractString(toString(events.properties), \'$current_url\') = \'https://console.capgo.app\'')
    expect(filter).toContain('JSONExtractString(toString(events.properties), \'$current_url\') LIKE \'https://console.capgo.app/%\'')
  })
})

describe('buildFrontendOnboardingHogql', () => {
  it('queries supported pre-org attempts and joins actor-scoped CLI starts by human identity', () => {
    const query = buildFrontendOnboardingHogql(
      '2026-08-01T00:00:00.123Z',
      '2026-08-03T00:00:00.456Z',
      '2026-08-04T00:00:00.789Z',
    )

    expect(query).toContain("event IN ('onboarding_step_viewed', 'onboarding_ai_instructions_copied'")
    expect(query).toContain("'onboarding_app_id_entered'")
    expect(query).toContain("'onboarding_app_creation_succeeded'")
    expect(query).not.toContain("'onboarding_app_details_step_completed'")
    expect(query).not.toContain("'onboarding_app_details_step_viewed'")
    expect(query).toContain("'onboarding_store_icon_import_succeeded'")
    expect(query).toContain("'onboarding_store_icon_url_entered'")
    expect(query).toContain("'onboarding_organization_import_opened'")
    expect(query).toContain("'onboarding_organization_invite_succeeded'")
    expect(query).toContain("'onboarding_technical_invite_succeeded'")
    expect(query).toContain('JSONExtractString(toString(properties), \'flow\') = \'pre_org\'')
    expect(query).toContain('JSONExtractString(toString(properties), \'$host\') = \'console.capgo.app\'')
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) AS onboarding_version')
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) IN (1, 2, 3, 4)')
    expect(query).not.toContain('toInt64OrZero')
    expect(query).toContain('JSONExtractString(toString(properties), \'onboarding_attempt_id\')')
    expect(query).toContain('JSONExtractString(toString(properties), \'step\')')
    expect(query).not.toMatch(/WITH\s+JSONExtractString/)
    expect(query).toContain('toString(person_id) AS person_id')
    expect(query).toContain('onboarding_attempts.person_id AS person_id')
    expect(query).toContain('JSONExtractString(toString(properties), \'channel\') = \'onboarding-v2\'')
    expect(query).toContain('event = \'CLI Command Invoked\'')
    expect(query).toContain('JSONExtractString(toString(properties), \'command_path\') = \'init\'')
    expect(query).toContain('event = \'Builder Onboarding Step\'')
    expect(query).toContain('JSONExtractString(toString(properties), \'step\') IN (\'welcome\', \'resume-prompt\')')
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, event = \'onboarding_step_viewed\' AND step = \'intent\'))')
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step IN ('details', 'app_name'))) AS details_ms")
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_name')) AS app_name_ms")
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_id')) AS app_id_ms")
    expect(query).toContain("toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_icon')) AS app_icon_ms")
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, event = \'onboarding_step_viewed\' AND step = \'organization\'))')
    expect(query).toContain('toUnixTimestamp64Milli(minIf(timestamp, event = \'onboarding_step_viewed\' AND step = \'setup\'))')
    expect(query).toContain('groupUniqArrayIf(tuple(event, toUnixTimestamp64Milli(timestamp)), event IN (')
    expect(query).toContain('groupUniqArrayIf(toUnixTimestamp64Milli(timestamp), event = \'onboarding_ai_instructions_copied\') AS ai_instructions_copied_ms')
    expect(query).toContain('groupUniqArray(toUnixTimestamp64Milli(timestamp)) AS cli_started_ms')
    expect(query).toContain('GROUP BY onboarding_version, attempt_id')
    expect(query).toContain('LEFT JOIN cli_starts USING person_id')
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

describe('buildFrontendOnboardingWelcomeHogql', () => {
  it('queries only production v4 pre-org Welcome and Intent views', () => {
    const query = buildFrontendOnboardingWelcomeHogql(
      '2026-07-31T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )

    expect(query).toContain("event = 'onboarding_step_viewed'")
    expect(query).toContain("toIntOrZero(toString(properties.onboarding_version)) = 4")
    expect(query).toContain("JSONExtractString(toString(properties), 'flow') = 'pre_org'")
    expect(query).toContain("JSONExtractString(toString(properties), '$host') = 'console.capgo.app'")
    expect(query).toContain("JSONExtractString(toString(properties), 'step') AS step")
    expect(query).toContain("step IN ('welcome', 'intent')")
    expect(query).toContain("timestamp >= parseDateTimeBestEffort('2026-07-31T00:00:00.000Z')")
    expect(query).toContain("timestamp < parseDateTimeBestEffort('2026-08-04T00:00:00.000Z')")
    expect(query).toContain("trim(attempt_id) != ''")
    expect(query).toContain("minIf(timestamp, step = 'welcome')")
    expect(query).toContain("minIf(timestamp, step = 'intent')")
    expect(query).toContain("parseDateTimeBestEffort('2026-08-01T00:00:00.000Z')")
    expect(query).toContain("parseDateTimeBestEffort('2026-08-03T00:00:00.000Z')")
    expect(query).toContain('count() OVER () AS total_attempts')
    expect(query).toContain('ORDER BY anchor_ms ASC, attempt_id ASC')
    expect(query).toContain('LIMIT 50000')
    expect(query).not.toContain('onboarding_version IN (1, 2, 3, 4)')
  })
})

describe('buildFrontendOnboardingTabSwitchHogql', () => {
  it('counts only production v4 hidden events by day and active onboarding step', () => {
    const query = buildFrontendOnboardingTabSwitchHogql(
      '2026-08-01T00:00:00.123Z',
      '2026-08-03T00:00:00.456Z',
    )

    expect(query).toContain("event = 'onboarding_visibility_changed'")
    expect(query).toContain("JSONExtractString(toString(properties), 'visibility_state') = 'hidden'")
    expect(query).toContain("JSONExtractString(toString(properties), 'flow') = 'pre_org'")
    expect(query).toContain("JSONExtractString(toString(properties), '$host') = 'console.capgo.app'")
    expect(query).toContain('toIntOrZero(toString(properties.onboarding_version)) = 4')
    expect(query).toContain("toString(toDate(toTimeZone(timestamp, 'UTC'))) AS date")
    expect(query).not.toContain("toDate(timestamp, 'UTC')")
    expect(query).toContain("step IN ('welcome', 'intent', 'app_name', 'app_id', 'app_icon', 'organization')")
    expect(query).toContain("countIf(step = 'welcome') AS welcome")
    expect(query).toContain("countIf(step = 'intent') AS intent")
    expect(query).toContain("countIf(step = 'app_name') AS app_name")
    expect(query).toContain("countIf(step = 'app_id') AS app_id")
    expect(query).toContain("countIf(step = 'app_icon') AS app_icon")
    expect(query).toContain("countIf(step = 'organization') AS organization")
    expect(query).toContain("timestamp >= parseDateTimeBestEffort('2026-08-01T00:00:00.123Z')")
    expect(query).toContain("timestamp < parseDateTimeBestEffort('2026-08-03T00:00:00.456Z')")
    expect(query).toContain('GROUP BY date')
    expect(query).toContain('ORDER BY date ASC')
    expect(query).not.toContain("visibility_state') = 'visible'")
  })
})

describe('buildFrontendOnboardingDailyTabSwitches', () => {
  it('normalizes counts and fills days without hidden events', () => {
    expect(buildFrontendOnboardingDailyTabSwitches([
      {
        date: '2026-08-01',
        welcome: 2,
        intent: '3',
        app_name: 20,
        app_id: 4,
        app_icon: 1,
        organization: 5,
      },
      {
        date: '2026-08-01',
        welcome: 1,
        intent: 0,
        app_name: 0,
        app_id: 0,
        app_icon: 0,
        organization: 0,
      },
      {
        date: '2026-08-03',
        welcome: 99,
      },
    ], Date.parse('2026-08-01T00:00:00.000Z'), Date.parse('2026-08-03T00:00:00.000Z'))).toEqual([
      {
        date: '2026-08-01',
        welcome: 3,
        intent: 3,
        app_name: 20,
        app_id: 4,
        app_icon: 1,
        organization: 5,
      },
      {
        date: '2026-08-02',
        welcome: 0,
        intent: 0,
        app_name: 0,
        app_id: 0,
        app_icon: 0,
        organization: 0,
      },
    ])
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['non-numeric', 'invalid'],
    ['missing', undefined],
  ])('rejects a %s aggregate count instead of silently reporting zero', (_label, invalidCount) => {
    expect(() => buildFrontendOnboardingDailyTabSwitches([{
      date: '2026-08-01',
      welcome: 2,
      intent: 3,
      app_name: invalidCount,
      app_id: 4,
      app_icon: 1,
      organization: 5,
    }], Date.parse('2026-08-01T00:00:00.000Z'), Date.parse('2026-08-02T00:00:00.000Z'))).toThrow(
      'frontend onboarding tab-switch query returned an invalid count',
    )
  })

  it('keeps event counts from partial first and last UTC days', () => {
    expect(buildFrontendOnboardingDailyTabSwitches([
      { date: '2026-08-01', welcome: 2, intent: 0, app_name: 0, app_id: 0, app_icon: 0, organization: 0 },
      { date: '2026-08-02', welcome: 0, intent: 3, app_name: 0, app_id: 0, app_icon: 0, organization: 0 },
    ], Date.parse('2026-08-01T12:00:00.000Z'), Date.parse('2026-08-02T06:00:00.000Z'))).toEqual([
      { date: '2026-08-01', welcome: 2, intent: 0, app_name: 0, app_id: 0, app_icon: 0, organization: 0 },
      { date: '2026-08-02', welcome: 0, intent: 3, app_name: 0, app_id: 0, app_icon: 0, organization: 0 },
    ])
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
  it('maps grouped v1, v2, and v4 rows, including repeated v4 interactions', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const intentMs = Date.parse(start) + 60 * 60 * 1000 + 123
    const dailySetupMs = Date.parse(start) + 2 * 60 * 60 * 1000
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        attempt_id: 'attempt-1',
        person_id: 'person-v4',
        onboarding_version: 4,
        intent_ms: intentMs,
        details_ms: intentMs + 555,
        app_name_ms: intentMs + 555,
        app_id_ms: intentMs + 777,
        app_icon_ms: intentMs + 888,
        organization_ms: intentMs + 1_000,
        setup_ms: intentMs + 2_666,
        interaction_events: [
          ['onboarding_app_id_entered', intentMs + 100],
          ['onboarding_app_id_entered', intentMs + 200],
        ],
        ai_instructions_copied_ms: [],
        cli_started_ms: [],
        total_attempts: 3,
      }, {
        attempt_id: 'attempt-v2',
        person_id: 'person-v2',
        onboarding_version: 2,
        intent_ms: intentMs + 500,
        details_ms: intentMs + 1_000,
        organization_ms: intentMs + 1_500,
        setup_ms: intentMs + 2_500,
        interaction_events: [['onboarding_app_name_entered', intentMs + 800]],
        ai_instructions_copied_ms: [intentMs + 3_000],
        cli_started_ms: [intentMs + 3_200],
        total_attempts: 3,
      }, {
        attempt_id: 'attempt-v1',
        onboarding_version: 1,
        intent_ms: intentMs + 1_000,
        interaction_events: [['onboarding_store_import_submitted', intentMs + 1_100]],
        total_attempts: 3,
      }],
    })
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        person_id: 'person-1',
        timestamp_ms: dailySetupMs,
        event_kind: 'setup',
        command_path: '',
        total_events: 3,
      }, {
        person_id: 'person-1',
        timestamp_ms: dailySetupMs + 1_000,
        event_kind: 'cli_copy',
        command_path: '',
        total_events: 3,
      }, {
        person_id: 'person-1',
        timestamp_ms: dailySetupMs + 2_000,
        event_kind: 'cli_command',
        command_path: 'init',
        total_events: 3,
      }],
    })
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{
        attempt_id: 'welcome-advanced',
        person_id: 'welcome-person-1',
        welcome_ms: intentMs,
        intent_ms: intentMs + 1_000,
        total_attempts: 3,
      }, {
        attempt_id: 'welcome-not-viewed',
        person_id: 'welcome-person-2',
        welcome_ms: 0,
        intent_ms: intentMs + 2_000,
        total_attempts: 3,
      }, {
        attempt_id: 'welcome-not-advanced',
        person_id: 'welcome-person-3',
        welcome_ms: intentMs + DAY_MS,
        intent_ms: 0,
        total_attempts: 3,
      }],
    })

    const result = await getAdminFrontendOnboardingAnalytics(createContext(), start, '2026-08-03T00:00:00.000Z')

    expect(result).toMatchObject({
      kpis: { attempts: 0, completed: 0, completion_rate: 0, median_completion_ms: null },
      v4_kpis: { attempts: 1, completed: 1, completion_rate: 100, median_completion_ms: 2_666 },
      daily_attempts: [
        { date: '2026-08-01', v1_attempts: 1, v2_attempts: 1, v3_attempts: 0, v4_attempts: 1 },
        { date: '2026-08-02', v1_attempts: 0, v2_attempts: 0, v3_attempts: 0, v4_attempts: 0 },
      ],
      daily_welcome_outcomes: [
        { date: '2026-08-01', welcome_advanced_to_intent: 1, welcome_not_viewed: 1, welcome_did_not_advance: 0 },
        { date: '2026-08-02', welcome_advanced_to_intent: 0, welcome_not_viewed: 0, welcome_did_not_advance: 1 },
      ],
      deduplicated: {
        daily_welcome_outcomes: [
          { date: '2026-08-01', welcome_advanced_to_intent: 1, welcome_not_viewed: 1, welcome_did_not_advance: 0 },
          { date: '2026-08-02', welcome_advanced_to_intent: 0, welcome_not_viewed: 0, welcome_did_not_advance: 1 },
        ],
      },
      funnels: { v4: [
        { key: 'intent', reached: 1 },
        { key: 'app_name', reached: 1 },
        { key: 'app_id', reached: 1 },
        { key: 'app_icon', reached: 1 },
        { key: 'organization', reached: 1 },
        { key: 'setup', reached: 1 },
      ] },
      v4_graph: { nodes: [{ key: 'onboarding_app_id_entered', count: 1 }] },
      v2_graph: { nodes: [{ key: 'onboarding_app_name_entered', count: 1 }] },
      v2_v3_setup_cli_outcomes: {
        total_users: 1,
        cli_only: 0,
        cli_and_ai_instructions: 1,
        no_cli: 0,
      },
      v2_v4_setup_cli_outcomes: {
        total_users: 2,
        cli_only: 0,
        cli_and_ai_instructions: 1,
        no_cli: 1,
      },
      posthog_configured: true,
      posthog_connected: true,
    })
    expect(result.v4_daily_conversions.details_to_organization[0]).toMatchObject({ started: 1, converted: 1 })
    expect(result.daily_setup_cli_outcomes).toEqual([
      {
        date: '2026-08-01',
        first_time: {
          ...createFrontendOnboardingDailySetupCliOutcomeCounts(),
          cli_copy_init: 1,
        },
        returning: createFrontendOnboardingDailySetupCliOutcomeCounts(),
      },
      {
        date: '2026-08-02',
        first_time: createFrontendOnboardingDailySetupCliOutcomeCounts(),
        returning: createFrontendOnboardingDailySetupCliOutcomeCounts(),
      },
    ])
    expect(result.v2_v3_setup_cli_outcomes).toEqual({
      total_users: 1,
      cli_only: 0,
      cli_and_ai_instructions: 1,
      no_cli: 0,
    })
    expect(result.v2_v4_setup_cli_outcomes).toEqual({
      total_users: 2,
      cli_only: 0,
      cli_and_ai_instructions: 1,
      no_cli: 1,
    })
    expect(result).not.toHaveProperty('onboarding_version')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
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
    expect(result.daily_setup_cli_outcomes).toEqual([
      {
        date: '2026-08-01',
        first_time: createFrontendOnboardingDailySetupCliOutcomeCounts(),
        returning: createFrontendOnboardingDailySetupCliOutcomeCounts(),
      },
      {
        date: '2026-08-02',
        first_time: createFrontendOnboardingDailySetupCliOutcomeCounts(),
        returning: createFrontendOnboardingDailySetupCliOutcomeCounts(),
      },
    ])
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
  })

  it('returns zero-filled daily hidden-event counts split by v4 onboarding step', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({
        configured: true,
        connected: true,
        failureReason: null,
        rows: [{
          date: '2026-08-01',
          welcome: 2,
          intent: 3,
          app_name: 20,
          app_id: 4,
          app_icon: 1,
          organization: 5,
        }],
      })

    const result = await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result.daily_tab_switches).toEqual([
      {
        date: '2026-08-01',
        welcome: 2,
        intent: 3,
        app_name: 20,
        app_id: 4,
        app_icon: 1,
        organization: 5,
      },
      {
        date: '2026-08-02',
        welcome: 0,
        intent: 0,
        app_name: 0,
        app_id: 0,
        app_icon: 0,
        organization: 0,
      },
    ])
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
    expect(queryPosthogHogqlMock.mock.calls[3][1]).toContain("event = 'onboarding_visibility_changed'")
  })

  it('logs and fails closed when a tab-switch aggregate row is malformed', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({
        configured: true,
        connected: true,
        failureReason: null,
        rows: [{
          date: '2026-08-01',
          welcome: 2,
          intent: 3,
          app_name: 'not-a-count',
          app_id: 4,
          app_icon: 1,
          organization: 5,
        }],
      })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('frontend onboarding tab-switch query returned an invalid count')

    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_tab_switch_invalid_row',
      returned_rows: 1,
    })
  })

  it('fails closed when the daily Setup CLI PostHog query fails', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: false, failureReason: 'timeout', rows: [] })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics PostHog query failed')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
  })

  it('propagates an aggregate query rejection while the daily query is configured', async () => {
    queryPosthogHogqlMock
      .mockRejectedValueOnce(new Error('aggregate PostHog request rejected'))
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('aggregate PostHog request rejected')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
  })

  it('propagates a daily query rejection while the aggregate query is configured', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockRejectedValueOnce(new Error('daily PostHog request rejected'))

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('daily PostHog request rejected')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
  })

  it('fails closed when the Welcome outcomes PostHog query fails', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: false, failureReason: 'timeout', rows: [] })

    await expect(getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )).rejects.toThrow('frontend onboarding Welcome analytics PostHog query failed')
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
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
        { attempt_id: 'unknown-version', onboarding_version: 5, intent_ms: startMs + 1_000, total_attempts: 10 },
        { attempt_id: 'string-version', onboarding_version: '3', intent_ms: startMs + 1_000, total_attempts: 10 },
        { attempt_id: 'boolean-step', onboarding_version: 4, intent_ms: startMs + 2_000, details_ms: true, organization_ms: [], setup_ms: {}, interaction_events: 'not-an-array', total_attempts: 10 },
        { attempt_id: 'valid', onboarding_version: 4, intent_ms: String(startMs + 1_000), details_ms: undefined, organization_ms: 0, setup_ms: 'not-a-number', interaction_events: [[' valid ', startMs + 2_000], ['', startMs + 2_000], ['missing-time'], 42, null], total_attempts: 10 },
      ],
    })
    queryPosthogHogqlMock.mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { attempt_id: ' ', person_id: 'ignored-empty-id', welcome_ms: startMs + 1_000, intent_ms: 0, total_attempts: 4 },
        { attempt_id: 'ignored-empty-timestamps', person_id: 'ignored-empty', welcome_ms: 0, intent_ms: null, total_attempts: 4 },
        { attempt_id: false, person_id: 'ignored-invalid-id', welcome_ms: startMs + 1_000, intent_ms: 0, total_attempts: 4 },
        { attempt_id: 'valid-welcome', person_id: ' welcome-person ', welcome_ms: String(startMs + 2_000), intent_ms: startMs + 3_000, total_attempts: 4 },
      ],
    })

    const result = await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
    )

    expect(result).toMatchObject({
      v4_kpis: { attempts: 2, completed: 0, completion_rate: 0 },
      funnels: { v4: [
        { key: 'intent', reached: 2 },
        { key: 'app_name', reached: 0 },
        { key: 'app_id', reached: 0 },
        { key: 'app_icon', reached: 0 },
        { key: 'organization', reached: 0 },
        { key: 'setup', reached: 0 },
      ] },
      v4_graph: { nodes: [{ key: 'valid', count: 1 }] },
      daily_welcome_outcomes: [
        { date: '2026-08-01', welcome_advanced_to_intent: 1, welcome_not_viewed: 0, welcome_did_not_advance: 0 },
        { date: '2026-08-02', welcome_advanced_to_intent: 0, welcome_not_viewed: 0, welcome_did_not_advance: 0 },
      ],
    })
    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
  })

  it('queries the equal-length previous window through the current end plus 48 hours for post-setup outcomes', async () => {
    const start = '2026-08-01T00:00:00.000Z'
    const end = '2026-08-03T00:00:00.000Z'

    await getAdminFrontendOnboardingAnalytics(createContext(), start, end)

    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${new Date(Date.parse(start) - 2 * DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `timestamp < parseDateTimeBestEffort('${new Date(Date.parse(end) + 2 * DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `AND intent_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort('${end}'))`,
    )
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${start}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain(
      `timestamp < parseDateTimeBestEffort('${end}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain(
      `timestamp < parseDateTimeBestEffort('${new Date(Date.parse(end) + DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[2][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${new Date(Date.parse(start) - DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[2][1]).toContain(
      `timestamp < parseDateTimeBestEffort('${new Date(Date.parse(end) + DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[2][1]).toContain(
      `parseDateTimeBestEffort('${start}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[2][1]).toContain(
      `parseDateTimeBestEffort('${end}')`,
    )
  })

  it('queries a full 24-hour intent lookback for ranges shorter than the follow-up window', async () => {
    const start = '2026-08-01T12:00:00.000Z'
    const end = '2026-08-01T18:00:00.000Z'

    await getAdminFrontendOnboardingAnalytics(createContext(), start, end)

    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${new Date(Date.parse(start) - DAY_MS).toISOString()}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain(
      `HAVING intent_ms >= toUnixTimestamp64Milli(parseDateTimeBestEffort('${new Date(Date.parse(start) - DAY_MS).toISOString()}'))`,
    )
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${start}')`,
    )
    expect(queryPosthogHogqlMock.mock.calls[2][1]).toContain(
      `timestamp >= parseDateTimeBestEffort('${new Date(Date.parse(start) - DAY_MS).toISOString()}')`,
    )
  })

  it('accepts schema-valid sub-millisecond ISO fractions and normalizes them for PostHog', async () => {
    await getAdminFrontendOnboardingAnalytics(
      createContext(),
      '2026-08-01T00:00:00.1234Z',
      '2026-08-03T00:00:00.5678Z',
    )

    expect(queryPosthogHogqlMock).toHaveBeenCalledTimes(4)
    expect(queryPosthogHogqlMock.mock.calls[0][1]).toContain('parseDateTimeBestEffort(\'2026-08-03T00:00:00.567Z\')')
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain('parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\')')
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain('parseDateTimeBestEffort(\'2026-08-03T00:00:00.567Z\')')
    expect(queryPosthogHogqlMock.mock.calls[1][1]).toContain('parseDateTimeBestEffort(\'2026-08-04T00:00:00.567Z\')')
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

  it('applies the same attempt limit to the Welcome outcomes query', async () => {
    queryPosthogHogqlMock
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({ configured: true, connected: true, failureReason: null, rows: [] })
      .mockResolvedValueOnce({
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
      source: 'welcome',
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
