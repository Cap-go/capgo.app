import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertFrontendOnboardingDailySetupCliEventTotal,
  buildFrontendOnboardingDailySetupCliHogql,
  FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT,
  getFrontendOnboardingDailySetupCliEvents,
} from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes.ts'

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

describe('buildFrontendOnboardingDailySetupCliHogql', () => {
  it('selects the bounded v2 and v3 Setup cohort and its Setup, copy, and unfiltered CLI events', () => {
    const query = buildFrontendOnboardingDailySetupCliHogql(
      '2026-08-01T00:00:00.123Z',
      '2026-08-03T00:00:00.456Z',
      '2026-08-04T00:00:00.789Z',
    )
    const setupPeople = query.match(/WITH setup_people AS \(([\s\S]*?)\n {4}\)\n {4}SELECT/)?.[1] ?? ''
    const selectedProjectionStart = query.indexOf('\n    SELECT\n      toString(selected_events.person_id)')
    const selectedFromStart = query.indexOf('\n    FROM events AS selected_events')
    const selectedOrderStart = query.indexOf('\n    ORDER BY person_id ASC')
    const selectedProjection = query.slice(selectedProjectionStart, selectedFromStart)
    const selectedEventsFromWhere = query.slice(selectedFromStart, selectedOrderStart)
    const selectedCliBranch = selectedEventsFromWhere.match(/AND \(\n([\s\S]*?)\n {8}OR \(/)?.[1] ?? ''
    const selectedSetupCopyBranch = selectedEventsFromWhere.match(/OR \(\n([\s\S]*?)\n {8}\)\n {6}\)/)?.[1] ?? ''

    expect(setupPeople).toContain('WHERE event = \'onboarding_step_viewed\'')
    expect(setupPeople).toContain('JSONExtractString(toString(properties), \'flow\') = \'pre_org\'')
    expect(setupPeople).toContain('JSONExtractString(toString(properties), \'$host\') = \'console.capgo.app\'')
    expect(setupPeople).toContain('toIntOrZero(toString(properties.onboarding_version)) IN (2, 3, 4)')
    expect(setupPeople).toContain('JSONExtractString(toString(properties), \'step\') = \'setup\'')
    expect(setupPeople).toContain('timestamp >= parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\')')
    expect(setupPeople).toContain('timestamp < parseDateTimeBestEffort(\'2026-08-03T00:00:00.456Z\')')
    expect(setupPeople).not.toContain('2026-08-04T00:00:00.789Z')

    expect(selectedProjection).toContain('toString(selected_events.person_id) AS person_id')
    expect(selectedProjection).toContain('toUnixTimestamp64Milli(selected_events.timestamp) AS timestamp_ms')
    expect(selectedProjection).toContain('selected_events.event = \'onboarding_step_viewed\', \'setup\'')
    expect(selectedProjection).toContain('selected_events.event = \'onboarding_cli_command_copied\', \'cli_copy\'')
    expect(selectedProjection).toContain('selected_events.event = \'onboarding_ai_instructions_copied\', \'ai_copy\'')
    expect(selectedProjection).toContain('\'cli_command\'\n      ) AS event_kind')
    expect(selectedProjection).toContain('if(selected_events.event = \'CLI Command Invoked\', JSONExtractString(toString(selected_events.properties), \'command_path\'), \'\') AS command_path')
    expect(selectedProjection).toContain('count() OVER () AS total_events')
    expect(selectedProjection).toContain('CLI Command Invoked')

    expect(selectedEventsFromWhere).toContain('INNER JOIN setup_people AS cohort')
    expect(selectedEventsFromWhere).toContain('ON toString(selected_events.person_id) = cohort.person_id')
    expect(selectedEventsFromWhere).toContain('selected_events.timestamp >= parseDateTimeBestEffort(\'2026-08-01T00:00:00.123Z\')')
    expect(selectedEventsFromWhere).toContain('selected_events.timestamp < parseDateTimeBestEffort(\'2026-08-04T00:00:00.789Z\')')
    expect(selectedEventsFromWhere).not.toContain('2026-08-03T00:00:00.456Z')
    expect(selectedEventsFromWhere).toContain('selected_events.event = \'CLI Command Invoked\'\n        OR (')
    expect(selectedEventsFromWhere).not.toContain('JSONExtractString(toString(selected_events.properties), \'channel\')')
    expect(selectedEventsFromWhere).not.toContain('JSONExtractString(toString(selected_events.properties), \'command_path\') = \'init\'')
    expect(selectedCliBranch).toContain('selected_events.event = \'CLI Command Invoked\'')
    expect(selectedCliBranch).not.toContain('JSONExtractString(toString(selected_events.properties), \'$host\')')
    expect(selectedSetupCopyBranch).toContain('selected_events.event IN (\'onboarding_step_viewed\', \'onboarding_cli_command_copied\', \'onboarding_ai_instructions_copied\')')
    expect(selectedSetupCopyBranch).toContain('JSONExtractString(toString(selected_events.properties), \'flow\') = \'pre_org\'')
    expect(selectedSetupCopyBranch).toContain('JSONExtractString(toString(selected_events.properties), \'$host\') = \'console.capgo.app\'')
    expect(selectedSetupCopyBranch).toContain('isNull(selected_events.properties[\'$host\'])')
    expect(selectedSetupCopyBranch).toContain('toDate(toTimeZone(selected_events.timestamp, \'UTC\')) = toDate(\'2026-08-22\')')
    expect(selectedSetupCopyBranch).toContain('toIntOrZero(toString(selected_events.properties.onboarding_version)) IN (2, 3, 4)')
    expect(selectedSetupCopyBranch).toContain('JSONExtractString(toString(selected_events.properties), \'step\') = \'setup\'')

    expect(query).toContain('count() OVER () AS total_events')
    expect(query).toContain('ORDER BY person_id ASC, timestamp_ms ASC, event_kind ASC, command_path ASC')
    expect(query).toContain('LIMIT 50000')
    expect(query).not.toContain('LIMIT 50001')
  })

  it('escapes interpolated date strings', () => {
    const query = buildFrontendOnboardingDailySetupCliHogql('start\'value', 'end\'value', 'followup\'value')

    expect(query).toContain('parseDateTimeBestEffort(\'start\'\'value\')')
    expect(query).toContain('parseDateTimeBestEffort(\'end\'\'value\')')
    expect(query).toContain('parseDateTimeBestEffort(\'followup\'\'value\')')
  })

  it('escapes a backslash immediately before a quote in interpolated date strings', () => {
    const query = buildFrontendOnboardingDailySetupCliHogql(String.raw`start\'value`, 'end', 'followup')

    expect(query).toContain(String.raw`parseDateTimeBestEffort('start\\''value')`)
  })
})

describe('assertFrontendOnboardingDailySetupCliEventTotal', () => {
  it('accepts finite non-negative integer totals through the limit', () => {
    expect(assertFrontendOnboardingDailySetupCliEventTotal(0)).toBe(0)
    expect(assertFrontendOnboardingDailySetupCliEventTotal(1, 1)).toBe(1)
    expect(assertFrontendOnboardingDailySetupCliEventTotal(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT))
      .toBe(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT)
    expect(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT).toBe(50_000)
  })

  it.each([undefined, null, '1', Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects malformed total metadata %s',
    (totalEvents) => {
      expect(() => assertFrontendOnboardingDailySetupCliEventTotal(totalEvents))
        .toThrow('daily Setup CLI analytics query returned invalid total metadata')
    },
  )

  it('uses a distinct error when the total exceeds the limit', () => {
    expect(() => assertFrontendOnboardingDailySetupCliEventTotal(2, 1))
      .toThrow('daily Setup CLI analytics query exceeded event limit')
  })
})

describe('getFrontendOnboardingDailySetupCliEvents', () => {
  it('strictly maps Setup, copy, and CLI rows while preserving the raw CLI command path', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: ' person-1 ', timestamp_ms: '1000', event_kind: 'setup', command_path: 'ignored', total_events: 5 },
        { person_id: 'person-1', timestamp_ms: 1100, event_kind: 'cli_copy', command_path: '', total_events: 5 },
        { person_id: 'person-1', timestamp_ms: 1200, event_kind: 'ai_copy', command_path: '', total_events: 5 },
        { person_id: 'person-1', timestamp_ms: 1300, event_kind: 'cli_command', command_path: 'init', total_events: 5 },
        { person_id: 'person-1', timestamp_ms: 1400, event_kind: 'cli_command', command_path: ' init ', total_events: 5 },
      ],
    })

    const result = await getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )

    expect(queryPosthogHogqlMock).toHaveBeenCalledWith(
      expect.anything(),
      buildFrontendOnboardingDailySetupCliHogql(
        '2026-08-01T00:00:00.000Z',
        '2026-08-03T00:00:00.000Z',
        '2026-08-04T00:00:00.000Z',
      ),
    )
    expect(result).toEqual([
      { personId: 'person-1', timestampMs: 1000, kind: 'setup' },
      { personId: 'person-1', timestampMs: 1100, kind: 'cli_copy' },
      { personId: 'person-1', timestampMs: 1200, kind: 'ai_copy' },
      { personId: 'person-1', timestampMs: 1300, kind: 'cli_command', commandPath: 'init' },
      { personId: 'person-1', timestampMs: 1400, kind: 'cli_command', commandPath: ' init ' },
    ])
  })

  it('returns an empty list for a successful empty query', async () => {
    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).resolves.toEqual([])
  })

  it.each([
    { configured: false, connected: true, failureReason: null },
    { configured: true, connected: false, failureReason: null },
    { configured: false, connected: false, failureReason: 'unconfigured' },
    { configured: true, connected: false, failureReason: 'unavailable' },
    { configured: true, connected: false, failureReason: 'timeout' },
    { configured: true, connected: true, failureReason: 'too_large' },
  ])('fails closed for configured=$configured, connected=$connected, failureReason=$failureReason', async (posthog) => {
    queryPosthogHogqlMock.mockResolvedValueOnce({ ...posthog, rows: [] })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics PostHog query failed')
  })

  it('logs total metadata and rejects when the event limit is exceeded', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 50_001 }],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query exceeded event limit')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_event_limit_exceeded',
      event_limit: 50_000,
      total_events: 50_001,
      returned_rows: 1,
    })
  })

  it('logs a distinct message and rejects invalid total metadata', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [{ person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: '1' }],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query returned invalid total metadata')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_invalid_total_events',
      event_limit: 50_000,
      total_events: '1',
      returned_rows: 1,
    })
  })

  it('logs and rejects malformed total metadata on a later row', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 2 },
        { person_id: 'person-1', timestamp_ms: 1100, event_kind: 'cli_copy', command_path: '', total_events: '2' },
      ],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query returned invalid total metadata')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_invalid_total_events',
      event_limit: 50_000,
      total_events: '2',
      returned_rows: 2,
    })
  })

  it('logs and rejects over-limit total metadata on a later row', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 2 },
        { person_id: 'person-1', timestamp_ms: 1100, event_kind: 'cli_copy', command_path: '', total_events: 50_001 },
      ],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query exceeded event limit')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_event_limit_exceeded',
      event_limit: 50_000,
      total_events: 50_001,
      returned_rows: 2,
    })
  })

  it('logs and rejects inconsistent totals across rows', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 2 },
        { person_id: 'person-1', timestamp_ms: 1100, event_kind: 'cli_copy', command_path: '', total_events: 3 },
      ],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query returned invalid total metadata')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_invalid_total_events',
      event_limit: 50_000,
      total_events: 3,
      returned_rows: 2,
    })
  })

  it('logs and rejects when returned rows exceed the asserted total', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 1 },
        { person_id: 'person-1', timestamp_ms: 1100, event_kind: 'cli_copy', command_path: '', total_events: 1 },
      ],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query returned invalid total metadata')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_invalid_total_events',
      event_limit: 50_000,
      total_events: 1,
      returned_rows: 2,
    })
  })

  it('logs and rejects when returned rows are fewer than the asserted total', async () => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [
        { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 2 },
      ],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics query returned invalid total metadata')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_invalid_total_events',
      event_limit: 50_000,
      total_events: 2,
      returned_rows: 1,
    })
  })

  it.each([
    ['empty person', { person_id: ' ', timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 1 }],
    ['non-string person', { person_id: 42, timestamp_ms: 1000, event_kind: 'setup', command_path: '', total_events: 1 }],
    ['zero timestamp', { person_id: 'person-1', timestamp_ms: 0, event_kind: 'setup', command_path: '', total_events: 1 }],
    ['fractional timestamp', { person_id: 'person-1', timestamp_ms: 1000.5, event_kind: 'setup', command_path: '', total_events: 1 }],
    ['unsafe numeric timestamp', { person_id: 'person-1', timestamp_ms: Number.MAX_SAFE_INTEGER + 1, event_kind: 'setup', command_path: '', total_events: 1 }],
    ['unsafe numeric string timestamp', { person_id: 'person-1', timestamp_ms: String(Number.MAX_SAFE_INTEGER + 1), event_kind: 'setup', command_path: '', total_events: 1 }],
    ['decimal numeric string timestamp', { person_id: 'person-1', timestamp_ms: '1000.0', event_kind: 'setup', command_path: '', total_events: 1 }],
    ['scientific numeric string timestamp', { person_id: 'person-1', timestamp_ms: '1e3', event_kind: 'setup', command_path: '', total_events: 1 }],
    ['whitespace-padded numeric string timestamp', { person_id: 'person-1', timestamp_ms: ' 1000 ', event_kind: 'setup', command_path: '', total_events: 1 }],
    ['boolean timestamp', { person_id: 'person-1', timestamp_ms: true, event_kind: 'setup', command_path: '', total_events: 1 }],
    ['array timestamp', { person_id: 'person-1', timestamp_ms: [1000], event_kind: 'setup', command_path: '', total_events: 1 }],
    ['non-numeric timestamp', { person_id: 'person-1', timestamp_ms: 'later', event_kind: 'setup', command_path: '', total_events: 1 }],
    ['unknown kind', { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'unknown', command_path: '', total_events: 1 }],
    ['missing CLI path', { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'cli_command', total_events: 1 }],
    ['whitespace CLI path', { person_id: 'person-1', timestamp_ms: 1000, event_kind: 'cli_command', command_path: '   ', total_events: 1 }],
  ])('rejects the whole query result for a malformed %s row', async (_name, row) => {
    queryPosthogHogqlMock.mockResolvedValueOnce({
      configured: true,
      connected: true,
      failureReason: null,
      rows: [row],
    })

    await expect(getFrontendOnboardingDailySetupCliEvents(
      createContext(),
      '2026-08-01T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    )).rejects.toThrow('daily Setup CLI analytics row is invalid')
    expect(cloudlogErrMock).toHaveBeenCalledWith({
      requestId: 'request-id',
      message: 'frontend_onboarding_daily_setup_cli_invalid_row',
      row_index: 0,
      returned_rows: 1,
    })
  })
})
