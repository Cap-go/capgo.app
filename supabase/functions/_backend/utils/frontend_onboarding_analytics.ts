import type { Context } from 'hono'
import {
  buildFrontendOnboardingAnalytics,
  FRONTEND_ONBOARDING_FOLLOWUP_MS,
  FRONTEND_ONBOARDING_VERSION,
  type FrontendOnboardingAttempt,
} from './frontend_onboarding_analytics_model.ts'
import { cloudlogErr } from './logging.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const POSTHOG_MIN_DATE_MS = Date.UTC(1970, 0, 1)
const POSTHOG_MAX_DATE_MS = Date.UTC(2106, 0, 1)
const INVALID_TOTAL_ATTEMPTS_ERROR = 'frontend onboarding analytics query returned invalid total metadata'
const ATTEMPT_LIMIT_EXCEEDED_ERROR = 'frontend onboarding analytics query exceeded attempt limit'

export const FRONTEND_ONBOARDING_ATTEMPT_LIMIT = 50_000

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
  const millisecond = Number((millisecondValue ?? '').padEnd(3, '0'))
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
    if (!id || intentMs === null)
      return []

    return [{
      attemptId: id,
      intentMs,
      detailsMs: nullableMs(row.details_ms),
      organizationMs: nullableMs(row.organization_ms),
      setupMs: nullableMs(row.setup_ms),
    }]
  })
}

export function buildFrontendOnboardingHogql(startDate: string, followupEndDate: string): string {
  return `
    WITH
      JSONExtractString(toString(properties), 'onboarding_attempt_id') AS attempt_id,
      JSONExtractString(toString(properties), 'step') AS step
    SELECT
      attempt_id,
      count() OVER () AS total_attempts,
      toUnixTimestamp64Milli(minIf(timestamp, step = 'intent')) AS intent_ms,
      toUnixTimestamp64Milli(minIf(timestamp, step = 'details')) AS details_ms,
      toUnixTimestamp64Milli(minIf(timestamp, step = 'organization')) AS organization_ms,
      toUnixTimestamp64Milli(minIf(timestamp, step = 'setup')) AS setup_ms
    FROM events
    WHERE event = 'onboarding_step_viewed'
      AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
      AND toInt64OrZero(toString(properties.onboarding_version)) = 1
      AND timestamp >= parseDateTime64BestEffort(${sqlStr(startDate)})
      AND timestamp < parseDateTime64BestEffort(${sqlStr(followupEndDate)})
      AND trim(attempt_id) != ''
    GROUP BY attempt_id
    HAVING intent_ms > 0
    ORDER BY intent_ms ASC, attempt_id ASC
    LIMIT ${FRONTEND_ONBOARDING_ATTEMPT_LIMIT}`
}

export async function getAdminFrontendOnboardingAnalytics(c: Context, startDate: string, endDate: string) {
  const startMs = parseStrictPosthogDate(startDate)
  const endMs = parseStrictPosthogDate(endDate)
  if (endMs <= startMs)
    throw new RangeError('endDate must be greater than startDate')

  const durationMs = endMs - startMs
  const previousStartMs = startMs - durationMs
  const followupEndMs = endMs + FRONTEND_ONBOARDING_FOLLOWUP_MS
  if (previousStartMs < POSTHOG_MIN_DATE_MS || previousStartMs >= POSTHOG_MAX_DATE_MS
    || followupEndMs < POSTHOG_MIN_DATE_MS || followupEndMs >= POSTHOG_MAX_DATE_MS) {
    throw new RangeError('derived analytics date boundaries must be within the supported PostHog range')
  }

  const posthog = await queryPosthogHogql(
    c,
    buildFrontendOnboardingHogql(new Date(previousStartMs).toISOString(), new Date(followupEndMs).toISOString()),
  )
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

  return {
    onboarding_version: FRONTEND_ONBOARDING_VERSION,
    ...analytics,
    posthog_configured: posthog.configured,
    posthog_connected: posthog.connected,
  }
}
