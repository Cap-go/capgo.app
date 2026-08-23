import type { Context } from 'hono'
import type {
  FrontendOnboardingDailySetupCliEvent,
  FrontendOnboardingDailySetupCliEventKind,
} from './frontend_onboarding_daily_setup_cli_outcomes_model.ts'
import { buildFrontendOnboardingProductionHostHogql, FRONTEND_ONBOARDING_VERSIONS } from './frontend_onboarding_analytics_model.ts'
import { cloudlogErr } from './logging.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const INVALID_TOTAL_EVENTS_ERROR = 'daily Setup CLI analytics query returned invalid total metadata'
const EVENT_LIMIT_EXCEEDED_ERROR = 'daily Setup CLI analytics query exceeded event limit'
const INVALID_ROW_ERROR = 'daily Setup CLI analytics row is invalid'
const EVENT_KINDS = new Set<FrontendOnboardingDailySetupCliEventKind>(['setup', 'cli_copy', 'ai_copy', 'cli_command'])

export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT = 50_000

function sqlStr(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\'\'')}'`
}

function timestampMs(value: unknown): number | null {
  const timestamp = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN

  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function posthogBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean')
    return value
  if (value === 0 || value === 1)
    return value === 1

  return null
}

function mapEvent(row: Record<string, unknown>): FrontendOnboardingDailySetupCliEvent {
  const personId = typeof row.person_id === 'string' ? row.person_id.trim() : ''
  const timestamp = timestampMs(row.timestamp_ms)
  const kind = EVENT_KINDS.has(row.event_kind as FrontendOnboardingDailySetupCliEventKind)
    ? row.event_kind as FrontendOnboardingDailySetupCliEventKind
    : null

  if (!personId || timestamp === null || kind === null)
    throw new Error(INVALID_ROW_ERROR)

  if (kind === 'cli_command') {
    const commandPath = row.command_path
    if (typeof commandPath !== 'string' || commandPath.trim() === '')
      throw new Error(INVALID_ROW_ERROR)

    const agentInvoker = posthogBoolean(row.agent_invoker ?? false)
    if (agentInvoker === null)
      throw new Error(INVALID_ROW_ERROR)

    const agentId = row.agent_id ?? ''
    const agentName = row.agent_name ?? ''
    if (typeof agentId !== 'string' || typeof agentName !== 'string')
      throw new Error(INVALID_ROW_ERROR)

    return {
      personId,
      timestampMs: timestamp,
      kind,
      commandPath,
      agentInvoker,
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
      ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
    }
  }

  return { personId, timestampMs: timestamp, kind }
}

export function assertFrontendOnboardingDailySetupCliEventTotal(
  totalEvents: unknown,
  limit = FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT,
): number {
  if (typeof totalEvents !== 'number'
    || !Number.isFinite(totalEvents)
    || !Number.isInteger(totalEvents)
    || totalEvents < 0) {
    throw new Error(INVALID_TOTAL_EVENTS_ERROR)
  }
  if (totalEvents > limit)
    throw new Error(EVENT_LIMIT_EXCEEDED_ERROR)

  return totalEvents
}

export function buildFrontendOnboardingDailySetupCliHogql(
  startDate: string,
  endDate: string,
  followupEndDate: string,
): string {
  const setupVersionAllowlist = FRONTEND_ONBOARDING_VERSIONS.filter(version => version >= 2).join(', ')

  return `
    WITH setup_people AS (
      SELECT DISTINCT
        toString(person_id) AS person_id
      FROM events
      WHERE event = 'onboarding_step_viewed'
        AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
        AND ${buildFrontendOnboardingProductionHostHogql('properties', 'timestamp')}
        AND toIntOrZero(toString(properties.onboarding_version)) IN (${setupVersionAllowlist})
        AND JSONExtractString(toString(properties), 'step') = 'setup'
        AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(endDate)})
    )
    SELECT
      toString(selected_events.person_id) AS person_id,
      toUnixTimestamp64Milli(selected_events.timestamp) AS timestamp_ms,
      multiIf(
        selected_events.event = 'onboarding_step_viewed', 'setup',
        selected_events.event = 'onboarding_cli_command_copied', 'cli_copy',
        selected_events.event = 'onboarding_ai_instructions_copied', 'ai_copy',
        'cli_command'
      ) AS event_kind,
      if(selected_events.event = 'CLI Command Invoked', JSONExtractString(toString(selected_events.properties), 'command_path'), '') AS command_path,
      if(selected_events.event = 'CLI Command Invoked', JSONExtractBool(toString(selected_events.properties), 'agent_invoker'), false) AS agent_invoker,
      if(selected_events.event = 'CLI Command Invoked', JSONExtractString(toString(selected_events.properties.agent_identity), 'id'), '') AS agent_id,
      if(selected_events.event = 'CLI Command Invoked', JSONExtractString(toString(selected_events.properties.agent_identity), 'name'), '') AS agent_name,
      count() OVER () AS total_events
    FROM events AS selected_events
    INNER JOIN setup_people AS cohort
      ON toString(selected_events.person_id) = cohort.person_id
    WHERE selected_events.timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
      AND selected_events.timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
      AND (
        selected_events.event = 'CLI Command Invoked'
        OR (
          selected_events.event IN ('onboarding_step_viewed', 'onboarding_cli_command_copied', 'onboarding_ai_instructions_copied')
          AND JSONExtractString(toString(selected_events.properties), 'flow') = 'pre_org'
          AND ${buildFrontendOnboardingProductionHostHogql('selected_events.properties', 'selected_events.timestamp')}
          AND toIntOrZero(toString(selected_events.properties.onboarding_version)) IN (${setupVersionAllowlist})
          AND JSONExtractString(toString(selected_events.properties), 'step') = 'setup'
        )
      )
    ORDER BY person_id ASC, timestamp_ms ASC, event_kind ASC, command_path ASC
    LIMIT ${FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT}`
}

export async function getFrontendOnboardingDailySetupCliEvents(
  c: Context,
  startDate: string,
  endDate: string,
  followupEndDate: string,
): Promise<FrontendOnboardingDailySetupCliEvent[]> {
  const posthog = await queryPosthogHogql(
    c,
    buildFrontendOnboardingDailySetupCliHogql(startDate, endDate, followupEndDate),
  )
  if (!posthog.configured || !posthog.connected || posthog.failureReason !== null)
    throw new Error('daily Setup CLI analytics PostHog query failed')

  if (posthog.rows.length > 0) {
    let totalEvents = posthog.rows[0].total_events
    try {
      const expectedTotalEvents = assertFrontendOnboardingDailySetupCliEventTotal(totalEvents)
      for (let index = 1; index < posthog.rows.length; index++) {
        const row = posthog.rows[index]
        totalEvents = row.total_events
        const rowTotalEvents = assertFrontendOnboardingDailySetupCliEventTotal(totalEvents)
        if (rowTotalEvents !== expectedTotalEvents)
          throw new Error(INVALID_TOTAL_EVENTS_ERROR)
      }

      totalEvents = expectedTotalEvents
      if (posthog.rows.length !== expectedTotalEvents)
        throw new Error(INVALID_TOTAL_EVENTS_ERROR)
    }
    catch (error) {
      const message = error instanceof Error && error.message === EVENT_LIMIT_EXCEEDED_ERROR
        ? 'frontend_onboarding_daily_setup_cli_event_limit_exceeded'
        : 'frontend_onboarding_daily_setup_cli_invalid_total_events'
      cloudlogErr({
        requestId: c.get('requestId'),
        message,
        event_limit: FRONTEND_ONBOARDING_DAILY_SETUP_CLI_EVENT_LIMIT,
        total_events: totalEvents,
        returned_rows: posthog.rows.length,
      })
      throw error
    }
  }

  const events: FrontendOnboardingDailySetupCliEvent[] = []
  for (let rowIndex = 0; rowIndex < posthog.rows.length; rowIndex++) {
    try {
      events.push(mapEvent(posthog.rows[rowIndex]))
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'frontend_onboarding_daily_setup_cli_invalid_row',
        row_index: rowIndex,
        returned_rows: posthog.rows.length,
      })
      throw error
    }
  }

  return events
}
