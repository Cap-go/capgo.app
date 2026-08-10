import type { Context } from 'hono'
import {
  buildFrontendOnboardingAnalytics,
  FRONTEND_ONBOARDING_VERSION,
  type FrontendOnboardingAttempt,
} from './frontend_onboarding_analytics_model.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const MAX_DATE_MS = 8.64e15

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

function isValidDateMs(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS
}

function nullableMs(value: unknown): number | null {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null
}

function attemptId(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
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
      toUnixTimestamp(minIf(timestamp, step = 'intent')) * 1000 AS intent_ms,
      toUnixTimestamp(minIf(timestamp, step = 'details')) * 1000 AS details_ms,
      toUnixTimestamp(minIf(timestamp, step = 'organization')) * 1000 AS organization_ms,
      toUnixTimestamp(minIf(timestamp, step = 'setup')) * 1000 AS setup_ms
    FROM events
    WHERE event = 'onboarding_step_viewed'
      AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
      AND toInt64OrZero(toString(properties.onboarding_version)) = 1
      AND timestamp >= parseDateTimeBestEffort(${sqlStr(startDate)})
      AND timestamp < parseDateTimeBestEffort(${sqlStr(followupEndDate)})
      AND trim(attempt_id) != ''
    GROUP BY attempt_id
    HAVING intent_ms > 0`
}

export async function getAdminFrontendOnboardingAnalytics(c: Context, startDate: string, endDate: string) {
  const startMs = Date.parse(startDate)
  const endMs = Date.parse(endDate)
  if (!isValidDateMs(startMs) || !isValidDateMs(endMs) || endMs <= startMs)
    throw new RangeError('startDate and endDate must be valid dates, with endDate greater than startDate')

  const durationMs = endMs - startMs
  const previousStartMs = startMs - durationMs
  const followupEndMs = endMs + 24 * 60 * 60 * 1000
  if (!isValidDateMs(previousStartMs) || !isValidDateMs(followupEndMs))
    throw new RangeError('derived analytics date boundaries must be valid')

  const posthog = await queryPosthogHogql(
    c,
    buildFrontendOnboardingHogql(new Date(previousStartMs).toISOString(), new Date(followupEndMs).toISOString()),
  )
  const analytics = buildFrontendOnboardingAnalytics(mapAttempts(posthog.rows), startMs, endMs)

  return {
    onboarding_version: FRONTEND_ONBOARDING_VERSION,
    ...analytics,
    posthog_configured: posthog.configured,
    posthog_connected: posthog.connected,
  }
}
