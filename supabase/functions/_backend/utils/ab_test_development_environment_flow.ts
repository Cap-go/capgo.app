import type { Context } from 'hono'
import type { DevelopmentEnvironmentFlowAttempt } from './ab_test_development_environment_flow_model.ts'
import { buildDevelopmentEnvironmentFlow } from './ab_test_development_environment_flow_model.ts'
import { queryPosthogHogql } from './posthog_read.ts'

const EVENT_LIMIT = 50_000
const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000

function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    throw new RangeError('Invalid question flow date')
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`).replace('.000Z', 'Z'))
    throw new RangeError('Invalid question flow date')
  return ms
}

export function buildDevelopmentEnvironmentFlowHogql(startDate: string, endDate: string) {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (end <= start || end - start > MAX_RANGE_MS)
    throw new RangeError('Question flow range must be between zero and 365 days')
  // step and onboarding_version also have legacy numeric values. Extract
  // raw JSON strings to avoid PostHog's numeric property metadata hiding them.
  return `WITH question_events AS (
    SELECT person_id,
      JSONExtractString(toString(properties), 'onboarding_attempt_id') AS attempt_id,
      event, JSONExtractString(toString(properties), 'step') AS step,
      toUnixTimestamp64Milli(timestamp) AS event_ms,
      JSONExtractString(toString(properties), 'development_environment') AS answer
    FROM events
    WHERE timestamp >= parseDateTimeBestEffort('${new Date(start).toISOString()}')
      AND timestamp < parseDateTimeBestEffort('${new Date(end).toISOString()}')
      AND event IN ('onboarding_step_viewed', 'onboarding_step_completed', 'onboarding_development_environment_selected')
      AND JSONExtractString(toString(properties), '$host') = 'console.capgo.app'
      AND JSONExtractString(toString(properties), 'flow') = 'pre_org'
      AND (JSONExtractString(toString(properties), 'step') = 'publish_app_question'
        OR (event = 'onboarding_step_viewed'
          AND JSONExtractString(toString(properties), 'previous_step') = 'publish_app_question'
          AND JSONExtractString(toString(properties), 'step') IN ('details', 'app_name', 'app_id', 'app_icon', 'organization', 'setup')))
    LIMIT ${EVENT_LIMIT + 1}
  ), attempts AS (
    SELECT toString(person_id) AS person_id, attempt_id,
      groupArray(tuple(event, step, event_ms, answer)) AS events
    FROM question_events
    GROUP BY person_id, attempt_id
  )
  SELECT person_id, attempt_id, events,
    (SELECT count() FROM question_events) AS total_events,
    count() OVER () AS total_attempts
  FROM attempts
  LIMIT ${EVENT_LIMIT + 1}`
}

function count(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
    throw new Error('Invalid question flow count')
  return number
}

function mapAttempt(row: Record<string, unknown>): DevelopmentEnvironmentFlowAttempt {
  if (typeof row.person_id !== 'string' || typeof row.attempt_id !== 'string' || !Array.isArray(row.events))
    throw new Error('Invalid question flow attempt')
  return {
    personId: row.person_id,
    attemptId: row.attempt_id,
    events: row.events.map((event: unknown) => {
      if (!Array.isArray(event) || event.length !== 4 || typeof event[0] !== 'string' || typeof event[1] !== 'string' || typeof event[3] !== 'string')
        throw new Error('Invalid question flow event')
      const timestampMs = count(event[2])
      if (timestampMs === 0)
        throw new Error('Invalid question flow timestamp')
      return { event: event[0], step: event[1], timestampMs, answer: event[3] }
    }),
  }
}

export async function getAdminDevelopmentEnvironmentFlow(c: Context, startDate: string, endDate: string) {
  const query = buildDevelopmentEnvironmentFlowHogql(startDate, endDate)
  const result = await queryPosthogHogql(c, query)
  const metadata = {
    generated_at: new Date().toISOString(),
    period: { start: startDate, end: endDate },
    data_quality: { configured: result.configured, connected: result.connected, failure_reason: result.failureReason as string | null },
  }
  if (result.failureReason)
    return { ...metadata, reached: null, groups: null }
  try {
    if (result.rows.length > 0) {
      const totalEvents = count(result.rows[0].total_events)
      const totalAttempts = count(result.rows[0].total_attempts)
      if (totalEvents > EVENT_LIMIT || totalAttempts !== result.rows.length)
        throw new Error('Question flow query exceeds limit or is incomplete')
      if (result.rows.some(row => count(row.total_events) !== totalEvents || count(row.total_attempts) !== totalAttempts))
        throw new Error('Inconsistent question flow metadata')
      if (result.rows.reduce((sum, row) => sum + (Array.isArray(row.events) ? row.events.length : 0), 0) !== totalEvents)
        throw new Error('Incomplete question flow events')
    }
    return { ...metadata, ...buildDevelopmentEnvironmentFlow(result.rows.map(mapAttempt)) }
  }
  catch {
    return { ...metadata, data_quality: { ...metadata.data_quality, failure_reason: 'invalid_data' }, reached: null, groups: null }
  }
}
