import type { Context } from 'hono'
import type { FrontendOnboardingAttempt, FrontendOnboardingInteractionEvent, FrontendOnboardingVersion } from './frontend_onboarding_analytics_model.ts'
import type { FrontendOnboardingWelcomeAttempt } from './frontend_onboarding_welcome_outcomes_model.ts'
import {
  buildFrontendOnboardingAnalytics,
  buildFrontendOnboardingProductionHostHogql,
  FRONTEND_ONBOARDING_FOLLOWUP_MS,
  FRONTEND_ONBOARDING_VERSIONS,
} from './frontend_onboarding_analytics_model.ts'
import { getFrontendOnboardingDailySetupCliEvents } from './frontend_onboarding_daily_setup_cli_outcomes.ts'
import { buildFrontendOnboardingDailySetupCliOutcomes } from './frontend_onboarding_daily_setup_cli_outcomes_model.ts'
import { buildFrontendOnboardingWelcomeOutcomes } from './frontend_onboarding_welcome_outcomes_model.ts'
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
  'onboarding_app_creation_failed',
  'onboarding_app_creation_started',
  'onboarding_app_creation_succeeded',
  'onboarding_app_icon_import_selected',
  'onboarding_app_icon_removed',
  'onboarding_app_id_entered',
  'onboarding_app_id_help_opened',
  'onboarding_app_id_suggestion_selected',
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
  'onboarding_store_icon_import_failed',
  'onboarding_store_icon_import_hidden',
  'onboarding_store_icon_import_shown',
  'onboarding_store_icon_import_submitted',
  'onboarding_store_icon_import_succeeded',
  'onboarding_store_icon_url_entered',
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
const DAY_MS = 24 * 60 * 60 * 1000
const FRONTEND_ONBOARDING_TAB_SWITCH_STEPS = ['welcome', 'intent', 'app_name', 'app_id', 'app_icon', 'organization'] as const

export interface FrontendOnboardingDailyTabSwitches {
  date: string
  welcome: number
  intent: number
  app_name: number
  app_id: number
  app_icon: number
  organization: number
}

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
      appNameMs: nullableMs(row.app_name_ms),
      appIdMs: nullableMs(row.app_id_ms),
      appIconMs: nullableMs(row.app_icon_ms),
      organizationMs: nullableMs(row.organization_ms),
      setupMs: nullableMs(row.setup_ms),
      aiInstructionsCopiedMs: timestamps(row.ai_instructions_copied_ms),
      cliStartedMs: timestamps(row.cli_started_ms),
      interactionEvents: interactionEvents(row.interaction_events),
    }]
  })
}

function mapWelcomeAttempts(rows: Record<string, unknown>[]): FrontendOnboardingWelcomeAttempt[] {
  return rows.flatMap((row) => {
    const id = attemptId(row.attempt_id)
    const welcomeMs = nullableMs(row.welcome_ms)
    const intentMs = nullableMs(row.intent_ms)
    if (!id || (welcomeMs === null && intentMs === null))
      return []

    return [{
      attemptId: id,
      personId: personId(row.person_id),
      welcomeMs,
      intentMs,
    }]
  })
}

function emptyTabSwitchCounts(): Omit<FrontendOnboardingDailyTabSwitches, 'date'> {
  return {
    welcome: 0,
    intent: 0,
    app_name: 0,
    app_id: 0,
    app_icon: 0,
    organization: 0,
  }
}

function nonNegativeInteger(value: unknown): number {
  const count = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0)
    throw new TypeError('frontend onboarding tab-switch query returned an invalid count')
  return count
}

export function buildFrontendOnboardingDailyTabSwitches(
  rows: Record<string, unknown>[],
  startMs: number,
  endMs: number,
): FrontendOnboardingDailyTabSwitches[] {
  const dates: string[] = []
  const start = new Date(startMs)
  const firstDayMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  for (let dayMs = firstDayMs; dayMs < endMs; dayMs += DAY_MS)
    dates.push(new Date(dayMs).toISOString().slice(0, 10))

  const validDates = new Set(dates)
  const countsByDate = new Map<string, Omit<FrontendOnboardingDailyTabSwitches, 'date'>>()
  for (const row of rows) {
    const date = typeof row.date === 'string' ? row.date : ''
    if (!validDates.has(date))
      continue

    const counts = countsByDate.get(date) ?? emptyTabSwitchCounts()
    for (const step of FRONTEND_ONBOARDING_TAB_SWITCH_STEPS)
      counts[step] += nonNegativeInteger(row[step])
    countsByDate.set(date, counts)
  }

  return dates.map(date => ({ date, ...(countsByDate.get(date) ?? emptyTabSwitchCounts()) }))
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
        AND ${buildFrontendOnboardingProductionHostHogql('properties', 'timestamp')}
        AND toIntOrZero(toString(properties.onboarding_version)) IN (${versionAllowlist})
        AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
    ), onboarding_attempts AS (
      SELECT
        onboarding_version,
        attempt_id,
        toString(argMin(person_id, timestamp)) AS person_id,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'intent')) AS intent_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step IN ('details', 'app_name'))) AS details_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_name')) AS app_name_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_id')) AS app_id_ms,
        toUnixTimestamp64Milli(minIf(timestamp, event = 'onboarding_step_viewed' AND step = 'app_icon')) AS app_icon_ms,
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
      app_name_ms,
      app_id_ms,
      app_icon_ms,
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

export function buildFrontendOnboardingWelcomeHogql(
  eventStartDate: string,
  cohortStartDate: string,
  cohortEndDate: string,
  followupEndDate: string,
): string {
  return `
    WITH welcome_events AS (
      SELECT
        timestamp,
        person_id,
        JSONExtractString(toString(properties), 'onboarding_attempt_id') AS attempt_id,
        JSONExtractString(toString(properties), 'step') AS step
      FROM events
      WHERE event = 'onboarding_step_viewed'
        AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
        AND ${buildFrontendOnboardingProductionHostHogql('properties', 'timestamp')}
        AND toIntOrZero(toString(properties.onboarding_version)) = 4
        AND timestamp >= parseDateTimeBestEffort(${sqlStr(eventStartDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
    ), welcome_attempts AS (
      SELECT
        attempt_id,
        toString(argMin(person_id, timestamp)) AS person_id,
        toUnixTimestamp64Milli(minIf(timestamp, step = 'welcome')) AS welcome_ms,
        toUnixTimestamp64Milli(minIf(timestamp, step = 'intent')) AS intent_ms,
        if(welcome_ms > 0, welcome_ms, intent_ms) AS anchor_ms
      FROM welcome_events
      WHERE trim(attempt_id) != ''
        AND step IN ('welcome', 'intent')
      GROUP BY attempt_id
      HAVING anchor_ms >= toUnixTimestamp64Milli(parseDateTimeBestEffort(${sqlStr(cohortStartDate)}))
        AND anchor_ms < toUnixTimestamp64Milli(parseDateTimeBestEffort(${sqlStr(cohortEndDate)}))
    )
    SELECT
      attempt_id,
      person_id,
      count() OVER () AS total_attempts,
      welcome_ms,
      intent_ms,
      anchor_ms
    FROM welcome_attempts
    ORDER BY anchor_ms ASC, attempt_id ASC
    LIMIT ${FRONTEND_ONBOARDING_ATTEMPT_LIMIT}`
}

export function buildFrontendOnboardingTabSwitchHogql(startDate: string, endDate: string): string {
  const stepAllowlist = FRONTEND_ONBOARDING_TAB_SWITCH_STEPS.map(sqlStr).join(', ')
  return `
    WITH tab_switch_events AS (
      SELECT
        toString(toDate(toTimeZone(timestamp, 'UTC'))) AS date,
        JSONExtractString(toString(properties), 'step') AS step
      FROM events
      WHERE event = 'onboarding_visibility_changed'
        AND JSONExtractString(toString(properties), 'visibility_state') = 'hidden'
        AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
        AND ${buildFrontendOnboardingProductionHostHogql('properties', 'timestamp')}
        AND toIntOrZero(toString(properties.onboarding_version)) = 4
        AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
        AND timestamp < parseDateTimeBestEffort(${sqlStr(endDate)})
    )
    SELECT
      date,
      countIf(step = 'welcome') AS welcome,
      countIf(step = 'intent') AS intent,
      countIf(step = 'app_name') AS app_name,
      countIf(step = 'app_id') AS app_id,
      countIf(step = 'app_icon') AS app_icon,
      countIf(step = 'organization') AS organization
    FROM tab_switch_events
    WHERE step IN (${stepAllowlist})
    GROUP BY date
    ORDER BY date ASC`
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

  const welcomeQueryStartMs = startMs - FRONTEND_ONBOARDING_FOLLOWUP_MS
  const [posthog, dailySetupCliEvents, welcomePosthog, tabSwitchPosthog] = await Promise.all([
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
    queryPosthogHogql(
      c,
      buildFrontendOnboardingWelcomeHogql(
        new Date(welcomeQueryStartMs).toISOString(),
        normalizedStartDate,
        normalizedEndDate,
        new Date(dailyFollowupEndMs).toISOString(),
      ),
    ),
    queryPosthogHogql(
      c,
      buildFrontendOnboardingTabSwitchHogql(normalizedStartDate, normalizedEndDate),
    ),
  ])
  if (!posthog.configured || !posthog.connected || posthog.failureReason !== null)
    throw new Error('frontend onboarding analytics PostHog query failed')
  if (!welcomePosthog.configured || !welcomePosthog.connected || welcomePosthog.failureReason !== null)
    throw new Error('frontend onboarding Welcome analytics PostHog query failed')
  if (!tabSwitchPosthog.configured || !tabSwitchPosthog.connected || tabSwitchPosthog.failureReason !== null)
    throw new Error('frontend onboarding tab-switch analytics PostHog query failed')

  for (const [source, rows] of [
    ['aggregate', posthog.rows],
    ['welcome', welcomePosthog.rows],
  ] as const) {
    if (rows.length === 0)
      continue

    const totalAttempts = rows[0].total_attempts
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
        returned_rows: rows.length,
        source,
      })
      throw error
    }
  }
  const analytics = buildFrontendOnboardingAnalytics(mapAttempts(posthog.rows), startMs, endMs)
  const dailySetupCliOutcomes = buildFrontendOnboardingDailySetupCliOutcomes(dailySetupCliEvents, startMs, endMs)
  const welcomeOutcomes = buildFrontendOnboardingWelcomeOutcomes(mapWelcomeAttempts(welcomePosthog.rows), startMs, endMs)
  let dailyTabSwitches: FrontendOnboardingDailyTabSwitches[]
  try {
    dailyTabSwitches = buildFrontendOnboardingDailyTabSwitches(tabSwitchPosthog.rows, startMs, endMs)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'frontend_onboarding_tab_switch_invalid_row',
      returned_rows: tabSwitchPosthog.rows.length,
    })
    throw error
  }

  return {
    ...analytics,
    daily_welcome_outcomes: welcomeOutcomes.daily,
    deduplicated: {
      ...analytics.deduplicated,
      daily_welcome_outcomes: welcomeOutcomes.deduplicated,
    },
    daily_setup_cli_outcomes: dailySetupCliOutcomes,
    daily_tab_switches: dailyTabSwitches,
    posthog_configured: posthog.configured,
    posthog_connected: posthog.connected,
  }
}
