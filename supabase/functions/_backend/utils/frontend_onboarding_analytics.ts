import type { Context } from 'hono'
import type { FrontendOnboardingAttempt, FrontendOnboardingInteractionEvent, FrontendOnboardingVersion } from './frontend_onboarding_analytics_model.ts'
import {
  buildFrontendOnboardingAnalytics,
  FRONTEND_ONBOARDING_FOLLOWUP_MS,
  FRONTEND_ONBOARDING_PRODUCTION_HOST,
  FRONTEND_ONBOARDING_VERSIONS,
} from './frontend_onboarding_analytics_model.ts'
import { getFrontendOnboardingDailySetupCliEvents } from './frontend_onboarding_daily_setup_cli_outcomes.ts'
import { buildFrontendOnboardingDailySetupCliOutcomes } from './frontend_onboarding_daily_setup_cli_outcomes_model.ts'
import { cloudlogErr } from './logging.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/
const POSTHOG_MIN_DATE_MS = Date.UTC(1970, 0, 1)
const POSTHOG_MAX_DATE_MS = Date.UTC(2106, 0, 1)
const INVALID_TOTAL_ATTEMPTS_ERROR = 'frontend onboarding analytics query returned invalid total metadata'
const ATTEMPT_LIMIT_EXCEEDED_ERROR = 'frontend onboarding analytics query exceeded attempt limit'

export const FRONTEND_ONBOARDING_ATTEMPT_LIMIT = 50_000
export const FRONTEND_ONBOARDING_MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000

const ONBOARDING_INTERACTION_EVENTS = [
  'onboarding_app_id_entered',
  'onboarding_app_id_help_opened',
  'onboarding_app_icon_picked',
  'onboarding_app_icon_picker_closed_without_selection',
  'onboarding_app_icon_picker_open_failed',
  'onboarding_app_icon_picker_opened',
  'onboarding_app_icon_upload_failed',
  'onboarding_app_icon_uploaded',
  'onboarding_app_name_entered',
  'onboarding_store_import_failed',
  'onboarding_store_import_hidden',
  'onboarding_store_import_shown',
  'onboarding_store_import_submitted',
  'onboarding_store_import_succeeded',
  'onboarding_store_url_entered',
  'onboarding_organization_import_opened',
  'onboarding_organization_import_submitted',
  'onboarding_organization_import_succeeded',
  'onboarding_organization_import_failed',
  'onboarding_organization_invite_viewed',
  'onboarding_organization_invite_opened',
  'onboarding_organization_invite_succeeded',
  'onboarding_organization_invite_continued',
  'onboarding_technical_invite_opened',
  'onboarding_technical_invite_succeeded',
] as const

const AI_INSTRUCTIONS_COPIED_EVENT = 'onboarding_ai_instructions_copied'

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

function parseStrictPosthogDate(value: string): number {
  const match = ISO_UTC_PATTERN.exec(value)
  if (!match)
    throw new RangeError('date must be a strict ISO UTC timestamp')

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue, millisecondValue] = match
  const year = Number(yearValue)
  const month = Number(monthValue)
  const day = Number(dayValue)
  const hour = Number(hourValue)
  const minute = Number(minuteValue)
  const second = Number(secondValue)
  const millisecond = Number((millisecondValue ?? '').slice(0, 3).padEnd(3, '0'))
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const parsed = new Date(timestamp)
  if (!Number.isFinite(timestamp)
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
    || parsed.getUTCMilliseconds() !== millisecond
    || timestamp < POSTHOG_MIN_DATE_MS
    || timestamp >= POSTHOG_MAX_DATE_MS) {
    throw new RangeError('date must be within the supported PostHog range')
  }

  return timestamp
}

function nullableMs(value: unknown): number | null {
  const milliseconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null
}

function attemptId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function personId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function onboardingVersion(value: unknown): FrontendOnboardingVersion | null {
  return FRONTEND_ONBOARDING_VERSIONS.includes(value as FrontendOnboardingVersion)
    ? value as FrontendOnboardingVersion
    : null
}

function interactionEvents(value: unknown): FrontendOnboardingInteractionEvent[] {
  if (!Array.isArray(value))
    return []

  return value.flatMap((event) => {
    if (!Array.isArray(event) || typeof event[0] !== 'string' || event[0].trim() === '')
      return []

    const timestampMs = nullableMs(event[1])
    return timestampMs === null ? [] : [{ key: event[0].trim(), timestampMs }]
  })
}

function timestamps(value: unknown): number[] {
  if (!Array.isArray(value))
    return []

  return value.flatMap((timestamp) => {
    const timestampMs = nullableMs(timestamp)
    return timestampMs === null ? [] : [timestampMs]
  })
}

export function assertFrontendOnboardingAttemptTotal(totalAttempts: unknown, limit = FRONTEND_ONBOARDING_ATTEMPT_LIMIT): number {
  if (typeof totalAttempts !== 'number'
    || !Number.isFinite(totalAttempts)
    || !Number.isInteger(totalAttempts)
    || totalAttempts < 0) {
    throw new Error(INVALID_TOTAL_ATTEMPTS_ERROR)
  }
  if (totalAttempts > limit)
    throw new Error(ATTEMPT_LIMIT_EXCEEDED_ERROR)

  return totalAttempts
}

function mapAttempts(rows: Record<string, unknown>[]): FrontendOnboardingAttempt[] {
  return rows.flatMap((row) => {
    const id = attemptId(row.attempt_id)
    const intentMs = nullableMs(row.intent_ms)
    const version = onboardingVersion(row.onboarding_version)
    if (!id || intentMs === null || version === null)
      return []

    return [{
      attemptId: id,
      onboardingVersion: version,
      personId: personId(row.person_id),
      intentMs,
      detailsMs: nullableMs(row.details_ms),
      organizationMs: nullableMs(row.organization_ms),
      setupMs: nullableMs(row.setup_ms),
      aiInstructionsCopiedMs: timestamps(row.ai_instructions_copied_ms),
      cliStartedMs: timestamps(row.cli_started_ms),
      interactionEvents: interactionEvents(row.interaction_events),
    }]
  })
}

export function buildFrontendOnboardingHogql(startDate: string, cohortEndDate: string, followupEndDate: string): string {
  const eventAllowlist = ['onboarding_step_viewed', AI_INSTRUCTIONS_COPIED_EVENT, ...ONBOARDING_INTERACTION_EVENTS].map(sqlStr).join(', ')
  const interactionEventAllowlist = ONBOARDING_INTERACTION_EVENTS.map(sqlStr).join(', ')
  const versionAllowlist = FRONTEND_ONBOARDING_VERSIONS.join(', ')

  return `
    WITH frontend_events AS (
      SELECT
        event,
        timestamp,
        person_id,
        toIntOrZero(toString(properties.onboarding_version)) AS onboarding_version,
        JSONExtractString(toString(properties), 'onboarding_attempt_id') AS attempt_id,
        JSONExtractString(toString(properties), 'step') AS step
      FROM events
      WHERE event IN (${eventAllowlist})
        AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
        AND JSONExtractString(toString(properties), '$host') = ${sqlStr(FRONTEND_ONBOARDING_PRODUCTION_HOST)}
        AND toIntOrZero(toString(properties.onboarding_version)) IN (${versionAllowlist})
        AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
    ), onboarding_attempts AS (
      SELECT
        onboarding_version,
        attempt_id,
        toString(argMin(person_id, timestamp)) AS person_id,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'intent')) AS intent_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'details')) AS details_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'organization')) AS organization_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'setup')) AS setup_ms,
        groupUniqArrayIf(tuple(event, toUnixTimestamp64Milli(timestamp)), event IN (${interactionEventAllowlist})) AS interaction_events,
        groupUniqArrayIf(toUnixTimestamp64Milli(timestamp), event = ${sqlStr(AI_INSTRUCTIONS_COPIED_EVENT)}) AS ai_instructions_copied_ms
      FROM frontend_events
      WHERE trim(attempt_id) != ''
      GROUP BY onboarding_version, attempt_id
      HAVING intent_ms >= toUnixTimestamp64Milli(parseDateTimeBestEffort(${sqlStr(startDate)}))
        AND intent_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort(${sqlStr(cohortEndDate)}))
    ), cli_starts AS (
      SELECT
        toString(person_id) AS person_id,
        groupUniqArray(toUnixTimestamp64Milli(timestamp)) AS cli_started_ms
      FROM events
      WHERE timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
        AND (
          JSONExtractString(toString(properties), 'channel') = 'onboarding-v2'
          OR (event = 'CLI Command Invoked'
            AND JSONExtractString(toString(properties), 'command_path') = 'init')
          OR (event = 'Builder Onboarding Step'
            AND JSONExtractString(toString(properties), 'step') IN ('welcome', 'resume-prompt'))
        )
      GROUP BY person_id
    )
    SELECT
      onboarding_version,
      attempt_id,
      onboarding_attempts.person_id AS person_id,
      count() OVER () AS total_attempts,
      intent_ms,
      details_ms,
      organization_ms,
      setup_ms,
      interaction_events,
      ai_instructions_copied_ms,
      cli_started_ms
    FROM onboarding_attempts
    LEFT JOIN cli_starts USING person_id
    ORDER BY intent_ms ASC, onboarding_version ASC, attempt_id ASC
    LIMIT ${FRONTEND_ONBOARDING_ATTEMPT_LIMIT}`
}

export async function getAdminFrontendOnboardingAnalytics(c: Context, startDate: string, endDate: string) {
  const startMs = parseStrictPosthogDate(startDate)
  const endMs = parseStrictPosthogDate(endDate)
  if (endMs <= startMs)
    throw new RangeError('endDate must be greater than startDate')

  const durationMs = endMs - startMs
  if (durationMs > FRONTEND_ONBOARDING_MAX_RANGE_MS)
    throw new RangeError('frontend onboarding analytics date range cannot exceed 365 days')

  const normalizedStartDate = new Date(startMs).toISOString()
  const normalizedEndDate = new Date(endMs).toISOString()
  const previousStartMs = startMs - durationMs
  const queryStartMs = Math.min(previousStartMs, startMs - FRONTEND_ONBOARDING_FOLLOWUP_MS)
  const dailyFollowupEndMs = endMs + FRONTEND_ONBOARDING_FOLLOWUP_MS
  const aggregateFollowupEndMs = endMs + 2 * FRONTEND_ONBOARDING_FOLLOWUP_MS
  if (queryStartMs < POSTHOG_MIN_DATE_MS || queryStartMs >= POSTHOG_MAX_DATE_MS
    || aggregateFollowupEndMs < POSTHOG_MIN_DATE_MS || aggregateFollowupEndMs >= POSTHOG_MAX_DATE_MS) {
    throw new RangeError('derived analytics date boundaries must be within the supported PostHog range')
  }

  const [posthog, dailySetupCliEvents] = await Promise.all([
    queryPosthogHogql(
      c,
      buildFrontendOnboardingHogql(
        new Date(queryStartMs).toISOString(),
        normalizedEndDate,
        new Date(aggregateFollowupEndMs).toISOString(),
      ),
    ),
    getFrontendOnboardingDailySetupCliEvents(
      c,
      normalizedStartDate,
      normalizedEndDate,
      new Date(dailyFollowupEndMs).toISOString(),
    ),
  ])
  if (!posthog.configured || !posthog.connected || posthog.failureReason !== null)
    throw new Error('frontend onboarding analytics PostHog query failed')

  if (posthog.rows.length > 0) {
    const totalAttempts = posthog.rows[0].total_attempts
    try {
      assertFrontendOnboardingAttemptTotal(totalAttempts)
    }
    catch (error) {
      const message = error instanceof Error && error.message === ATTEMPT_LIMIT_EXCEEDED_ERROR
        ? 'frontend_onboarding_analytics_attempt_limit_exceeded'
        : 'frontend_onboarding_analytics_invalid_total_attempts'
      cloudlogErr({
        requestId: c.get('requestId'),
        message,
        attempt_limit: FRONTEND_ONBOARDING_ATTEMPT_LIMIT,
        total_attempts: totalAttempts,
        returned_rows: posthog.rows.length,
      })
      throw error
    }
  }
  const analytics = buildFrontendOnboardingAnalytics(mapAttempts(posthog.rows), startMs, endMs)
  const dailySetupCliOutcomes = buildFrontendOnboardingDailySetupCliOutcomes(dailySetupCliEvents, startMs, endMs)

  return {
    ...analytics,
    daily_setup_cli_outcomes: dailySetupCliOutcomes,
    posthog_configured: posthog.configured,
    posthog_connected: posthog.connected,
  }
}
