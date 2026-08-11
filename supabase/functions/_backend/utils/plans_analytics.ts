import type { Context } from 'hono'
import type { DailyBillingPoint, DailyCheckoutIntentPoint, PlansBehaviorEvent } from './plans_analytics_model.ts'
import type { BillingTransition } from './plans_billing_history.ts'
import type { PosthogReadFailureReason, PosthogReadResult } from './posthog_read.ts'
import { cloudlog } from './logging.ts'
import {
  attributeCheckoutStarts,
  buildLogicalPlansOpenings,
  buildPlansChartData,
  CHECKOUT_ATTRIBUTION_MS,
  LEGACY_BURST_SECONDS,
} from './plans_analytics_model.ts'
import {
  classifyPlansBillingAt,
  loadPlansBillingHistories,
} from './plans_billing_history.ts'
import { MAX_POSTHOG_RESPONSE_BYTES, queryPosthogHogql } from './posthog_read.ts'

export const MAX_POSTHOG_ROWS = 200_000
export const TRACKING_HISTORY_START = '2026-02-23T00:00:00.000Z'
export const LEGACY_PATH_SOURCE = 'unavailable' as const
const TRANSITION_ORG_BATCH_SIZE = 1_000
export const TRANSITION_QUERY_CONCURRENCY = 4
export const MAX_PLANS_ORGANIZATIONS = TRANSITION_ORG_BATCH_SIZE * TRANSITION_QUERY_CONCURRENCY
export const MAX_TRANSITION_RESPONSE_BYTES = Math.floor(MAX_POSTHOG_RESPONSE_BYTES / TRANSITION_QUERY_CONCURRENCY)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type PlansAnalyticsFailureReason = PosthogReadFailureReason | 'too_large'

export interface PlansAnalyticsResponse {
  traffic: { dates: string[], uniqueVisitorOrganizations: number[], totalOpens: number[] }
  visitorBreakdown: DailyBillingPoint[]
  checkoutIntent: DailyCheckoutIntentPoint[]
  checkoutVisitorBreakdown: DailyBillingPoint[]
  dataQuality: {
    exactTrackingStartedAt: string | null
    legacyLogicalOpens: number
    exactLogicalOpens: number
    legacyReconstructionAvailable: boolean
    legacyUnavailableReason: 'missing_event_time_path' | null
    excludedMissingOrganization: number
    unmatchedCheckoutStarts: number
    unknownBillingOrganizations: number
    posthogConfigured: boolean
    posthogConnected: boolean
    posthogFailureReason: PlansAnalyticsFailureReason | null
    legacyDeduplicationSeconds: number | null
  }
}

interface QualityOverrides {
  exactTrackingStartedAt?: string | null
  exactLogicalOpens?: number
  excludedMissingOrganization?: number
  unmatchedCheckoutStarts?: number
  unknownBillingOrganizations?: number
  posthogConfigured?: boolean
  posthogConnected?: boolean
  posthogFailureReason?: PlansAnalyticsFailureReason | null
}

interface ParsedRange {
  startMs: number
  endMs: number
  startIso: string
  endIso: string
}

function legacyDeduplicationSeconds(reconstructionAvailable: boolean): number | null {
  return reconstructionAvailable ? LEGACY_BURST_SECONDS : null
}

function safeIso(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs))
    return null
  const date = new Date(timestampMs)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function parseRange(startDate: string, endDate: string): ParsedRange | null {
  if (typeof startDate !== 'string' || typeof endDate !== 'string')
    return null

  const startMs = Date.parse(startDate)
  const endMs = Date.parse(endDate)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs)
    return null

  const startIso = safeIso(startMs)
  const endIso = safeIso(endMs)
  if (!startIso || !endIso || !safeIso(startMs - LEGACY_BURST_SECONDS * 1000) || !safeIso(endMs + CHECKOUT_ATTRIBUTION_MS))
    return null

  return {
    startMs,
    endMs,
    startIso,
    endIso,
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

export function buildPlansBehaviorQuery(startDate: string, endDate: string): string {
  const range = parseRange(startDate, endDate)
  if (!range)
    return ''

  const queryStart = safeIso(range.startMs - LEGACY_BURST_SECONDS * 1000)!
  const queryEnd = safeIso(range.endMs + CHECKOUT_ATTRIBUTION_MS)!
  return `
SELECT
  toUnixTimestamp64Milli(timestamp) AS timestamp_ms,
  event,
  properties.org_id AS org_id,
  properties.$groups.organization AS grouped_org_id,
  properties.page AS page,
  properties.$session_id AS session_id,
  distinct_id
FROM events
WHERE event IN ('User visit', 'Checkout Started')
  AND (
    (event = 'User visit'
    AND properties.page = 'plans'
    AND timestamp >= parseDateTimeBestEffort(${sqlString(queryStart)})
    AND timestamp < parseDateTimeBestEffort(${sqlString(range.endIso)}))
    OR
    (event = 'Checkout Started'
    AND timestamp >= parseDateTimeBestEffort(${sqlString(range.startIso)})
    AND timestamp < parseDateTimeBestEffort(${sqlString(queryEnd)}))
  )
ORDER BY timestamp
LIMIT ${MAX_POSTHOG_ROWS + 1}`.trim()
}

export function buildBillingTransitionsQuery(endDate: string, orgIds: string[]): string {
  const endMs = Date.parse(endDate)
  if (!Number.isFinite(endMs))
    return ''

  const queryEnd = safeIso(endMs + CHECKOUT_ATTRIBUTION_MS)
  if (!queryEnd)
    return ''
  const organizationValues = orgIds.map(orgId => sqlString(orgId.trim())).join(', ')
  const organizationFilter = organizationValues
    ? `AND (properties.$group_key IN (${organizationValues}) OR properties.$groups.organization IN (${organizationValues}))`
    : 'AND 0 = 1'
  return `
SELECT
  toUnixTimestamp64Milli(timestamp) AS timestamp_ms,
  event,
  properties.$group_key AS group_key,
  properties.$group_type AS group_type,
  properties.$groups.organization AS grouped_org_id,
  properties.$group_set.plan_status AS plan_status,
  properties.plan_status AS event_plan_status,
  properties.$group_set.canceled_at AS canceled_at
FROM events
WHERE event IN ('User subscribe', 'User update subscribe', 'User cancel', '$groupidentify')
  AND timestamp >= parseDateTimeBestEffort(${sqlString(TRACKING_HISTORY_START)})
  AND timestamp < parseDateTimeBestEffort(${sqlString(queryEnd)})
  ${organizationFilter}
ORDER BY timestamp
LIMIT ${MAX_POSTHOG_ROWS + 1}`.trim()
}

export function buildExactTrackingStartQuery(): string {
  return `
SELECT min(timestamp) AS exact_tracking_started_at
FROM events
WHERE event = 'User visit'
  AND properties.page = 'plans'
  AND timestamp >= parseDateTimeBestEffort(${sqlString(TRACKING_HISTORY_START)})
  AND timestamp < now()
LIMIT ${MAX_POSTHOG_ROWS + 1}`.trim()
}

function emptyPlansAnalyticsResponse(
  startMs: number,
  endMs: number,
  quality: QualityOverrides = {},
): PlansAnalyticsResponse {
  const charts = buildPlansChartData({
    openings: [],
    attributedCheckouts: [],
    startMs,
    endMs,
    classifyAt: () => 'unknown',
  })

  return {
    ...charts,
    dataQuality: {
      exactTrackingStartedAt: quality.exactTrackingStartedAt ?? null,
      legacyLogicalOpens: 0,
      exactLogicalOpens: quality.exactLogicalOpens ?? 0,
      legacyReconstructionAvailable: false,
      legacyUnavailableReason: 'missing_event_time_path',
      excludedMissingOrganization: quality.excludedMissingOrganization ?? 0,
      unmatchedCheckoutStarts: quality.unmatchedCheckoutStarts ?? 0,
      unknownBillingOrganizations: quality.unknownBillingOrganizations ?? 0,
      posthogConfigured: quality.posthogConfigured ?? false,
      posthogConnected: quality.posthogConnected ?? false,
      posthogFailureReason: quality.posthogFailureReason ?? null,
      legacyDeduplicationSeconds: legacyDeduplicationSeconds(false),
    },
  }
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function normalizedUuid(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const normalized = value.trim().toLowerCase()
  return UUID_PATTERN.test(normalized) ? normalized : null
}

function organizationId(row: Record<string, unknown>): string | null {
  return normalizedUuid(row.org_id) ?? normalizedUuid(row.grouped_org_id)
}

function mapBehaviorRow(row: Record<string, unknown>): PlansBehaviorEvent | null {
  if (!Number.isFinite(row.timestamp_ms) || (row.event !== 'User visit' && row.event !== 'Checkout Started'))
    return null
  if (
    !isOptionalString(row.page)
    || !isOptionalString(row.session_id)
    || !isOptionalString(row.distinct_id)
  ) {
    return null
  }

  const orgId = organizationId(row)
  if (!orgId)
    return null

  return {
    event: row.event,
    timestampMs: row.timestamp_ms as number,
    orgId,
    actorId: row.distinct_id ?? '',
    sessionId: row.session_id ?? '',
    page: row.page ?? '',
    // Legacy reconstruction is unavailable. Event-time and person-current paths are intentionally ignored.
    path: '',
  }
}

function unresolvedOrganizationCount(rows: Record<string, unknown>[], range: ParsedRange): number {
  return rows.filter(row => (
    Number.isFinite(row.timestamp_ms)
    && (
      (
        row.event === 'User visit'
        && row.page === 'plans'
        && (row.timestamp_ms as number) >= range.startMs
        && (row.timestamp_ms as number) < range.endMs
      )
      || (
        row.event === 'Checkout Started'
        && (row.timestamp_ms as number) >= range.startMs
        && (row.timestamp_ms as number) < range.endMs + CHECKOUT_ATTRIBUTION_MS
      )
    )
    && !organizationId(row)
  )).length
}

function explicitTransitionKind(value: unknown): BillingTransition['kind'] | null {
  if (typeof value !== 'string')
    return null
  const status = value.trim().toLowerCase()
  if (status === 'past_due' || status === 'unpaid')
    return 'payment_problem'
  if (status === 'canceled' || status === 'cancelled' || status === 'deleted')
    return 'canceled'
  if (status === 'succeeded' || status === 'created' || status === 'updated' || status === 'active')
    return 'paid'
  return null
}

function transitionKind(row: Record<string, unknown>): BillingTransition['kind'] | null {
  if (row.event === 'User cancel')
    return 'canceled'
  if (row.event === 'User subscribe')
    return 'paid'
  if (row.event === 'User update subscribe')
    return explicitTransitionKind(row.event_plan_status)
  if (row.event !== '$groupidentify')
    return null

  if (typeof row.canceled_at === 'string' && Number.isFinite(Date.parse(row.canceled_at)))
    return 'canceled'
  return explicitTransitionKind(row.plan_status)
}

function transitionOrganizationId(row: Record<string, unknown>): string | null {
  const groupKey = row.group_type === 'organization' ? normalizedUuid(row.group_key) : null
  return groupKey ?? normalizedUuid(row.grouped_org_id)
}

function mapBillingTransitions(
  rows: Record<string, unknown>[],
  relevantOrganizations: ReadonlySet<string>,
): Map<string, BillingTransition[]> {
  const transitions = new Map<string, BillingTransition[]>()
  for (const row of rows) {
    if (!Number.isFinite(row.timestamp_ms))
      continue

    const orgId = transitionOrganizationId(row)
    const kind = transitionKind(row)
    if (!orgId || !relevantOrganizations.has(orgId) || !kind)
      continue

    const organizationTransitions = transitions.get(orgId) ?? []
    organizationTransitions.push({ timestampMs: row.timestamp_ms as number, kind })
    transitions.set(orgId, organizationTransitions)
  }
  return transitions
}

function exactTrackingStartedAt(rows: Record<string, unknown>[]): string | null {
  const value = rows[0]?.exact_tracking_started_at
  if (typeof value !== 'string')
    return null
  const timestampMs = Date.parse(value)
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null
}

function failedResult(results: PosthogReadResult[]): PosthogReadResult | null {
  return results.find(result => result.failureReason !== null || !result.connected) ?? null
}

export async function getAdminPlansAnalytics(
  c: Context,
  startDate: string,
  endDate: string,
): Promise<PlansAnalyticsResponse> {
  const startedAt = Date.now()
  const range = parseRange(startDate, endDate)
  if (!range)
    return emptyPlansAnalyticsResponse(0, 0)

  const behaviorResult = await queryPosthogHogql(c, buildPlansBehaviorQuery(range.startIso, range.endIso))
  const behaviorFailure = failedResult([behaviorResult])
  if (behaviorFailure) {
    return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
      posthogConfigured: behaviorFailure.configured,
      posthogConnected: behaviorFailure.connected,
      posthogFailureReason: behaviorFailure.failureReason ?? 'unavailable',
    })
  }
  if (behaviorResult.rows.length > MAX_POSTHOG_ROWS) {
    return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
      posthogConfigured: true,
      posthogConnected: true,
      posthogFailureReason: 'too_large',
    })
  }

  const excludedMissingOrganization = unresolvedOrganizationCount(behaviorResult.rows, range)
  const behaviorEvents = behaviorResult.rows.map(mapBehaviorRow).filter(event => event !== null)
  const exactEvents = behaviorEvents.filter(event => event.event !== 'User visit' || event.page === 'plans')
  const openings = buildLogicalPlansOpenings(exactEvents, range.startMs, range.endMs)
  const checkoutEvents = exactEvents.filter(event => (
    event.event === 'Checkout Started'
    && event.timestampMs >= range.startMs
    && event.timestampMs < range.endMs + CHECKOUT_ATTRIBUTION_MS
  ))
  const attributedCheckouts = attributeCheckoutStarts(openings, checkoutEvents)
  const orgIds = [...new Set(openings.map(opening => opening.orgId))]
  if (orgIds.length > MAX_PLANS_ORGANIZATIONS) {
    return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
      posthogConfigured: true,
      posthogConnected: true,
      posthogFailureReason: 'too_large',
    })
  }
  const relevantOrganizations = new Set(orgIds)
  const transitionRows: Record<string, unknown>[] = []
  const transitionBatches: string[][] = []
  for (let offset = 0; offset < orgIds.length; offset += TRANSITION_ORG_BATCH_SIZE) {
    transitionBatches.push(orgIds.slice(offset, offset + TRANSITION_ORG_BATCH_SIZE))
  }
  for (let offset = 0; offset < transitionBatches.length; offset += TRANSITION_QUERY_CONCURRENCY) {
    const wave = transitionBatches.slice(offset, offset + TRANSITION_QUERY_CONCURRENCY)
    const transitionResults = await Promise.all(wave.map(batch => (
      queryPosthogHogql(c, buildBillingTransitionsQuery(range.endIso, batch), { maxResponseBytes: MAX_TRANSITION_RESPONSE_BYTES })
    )))
    const transitionFailure = failedResult(transitionResults)
    if (transitionFailure) {
      return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
        posthogConfigured: transitionFailure.configured,
        posthogConnected: transitionFailure.connected,
        posthogFailureReason: transitionFailure.failureReason ?? 'unavailable',
      })
    }
    for (const transitionResult of transitionResults) {
      if (transitionResult.rows.length > MAX_POSTHOG_ROWS || transitionRows.length + transitionResult.rows.length > MAX_POSTHOG_ROWS) {
        return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
          posthogConfigured: true,
          posthogConnected: true,
          posthogFailureReason: 'too_large',
        })
      }
      for (const row of transitionResult.rows)
        transitionRows.push(row)
    }
  }

  const boundaryResult = await queryPosthogHogql(c, buildExactTrackingStartQuery())
  const boundaryFailure = failedResult([boundaryResult])
  if (boundaryFailure) {
    return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
      posthogConfigured: boundaryFailure.configured,
      posthogConnected: boundaryFailure.connected,
      posthogFailureReason: boundaryFailure.failureReason ?? 'unavailable',
    })
  }
  if (boundaryResult.rows.length > MAX_POSTHOG_ROWS) {
    return emptyPlansAnalyticsResponse(range.startMs, range.endMs, {
      posthogConfigured: true,
      posthogConnected: true,
      posthogFailureReason: 'too_large',
    })
  }

  const transitions = mapBillingTransitions(transitionRows, relevantOrganizations)
  const histories = await loadPlansBillingHistories(
    c,
    orgIds,
    range.startIso.slice(0, 10),
    range.endIso.slice(0, 10),
    transitions,
  )
  const unknownOrganizations = new Set<string>()
  const charts = buildPlansChartData({
    openings,
    attributedCheckouts,
    startMs: range.startMs,
    endMs: range.endMs,
    classifyAt: (orgId, timestampMs) => {
      const history = histories.get(orgId)
      const category = history ? classifyPlansBillingAt(history, timestampMs) : 'unknown'
      if (category === 'unknown')
        unknownOrganizations.add(orgId)
      return category
    },
  })

  const response: PlansAnalyticsResponse = {
    ...charts,
    dataQuality: {
      exactTrackingStartedAt: exactTrackingStartedAt(boundaryResult.rows),
      legacyLogicalOpens: 0,
      exactLogicalOpens: openings.length,
      legacyReconstructionAvailable: false,
      legacyUnavailableReason: 'missing_event_time_path',
      excludedMissingOrganization,
      unmatchedCheckoutStarts: checkoutEvents.length - attributedCheckouts.length,
      unknownBillingOrganizations: unknownOrganizations.size,
      posthogConfigured: true,
      posthogConnected: true,
      posthogFailureReason: null,
      legacyDeduplicationSeconds: legacyDeduplicationSeconds(false),
    },
  }
  cloudlog({
    requestId: c.get('requestId'),
    message: 'plans_analytics_aggregated',
    durationMs: Date.now() - startedAt,
    behaviorRows: behaviorResult.rows.length,
    transitionRows: transitionRows.length,
    logicalOpenings: openings.length,
    attributedCheckouts: attributedCheckouts.length,
  })
  return response
}
