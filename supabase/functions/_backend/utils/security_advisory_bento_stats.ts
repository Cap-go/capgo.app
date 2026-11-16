import type { Context } from 'hono'
import { BentoApiError, bentoGet, isBentoConfigured } from './bento.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

/** Bento custom events recorded when a security advisory email is sent to a subscriber. */
export const SECURITY_ADVISORY_EMAIL_SENT_EVENT = 'capgo:security_advisory_email_sent'
export const SECURITY_ADVISORY_EMAIL_DELIVERED_EVENT = 'capgo:security_advisory_email_delivered'
export const SECURITY_ADVISORY_EMAIL_OPENED_EVENT = 'capgo:security_advisory_email_opened'
export const SECURITY_ADVISORY_EMAIL_OPT_OUT_EVENT = 'capgo:security_advisory_email_opt_out'

export interface SecurityAdvisoryBentoEmailStats {
  sent: number
  delivered: number
  opened: number
  opt_outs: number
  bento_configured: boolean
  partial: boolean
}

interface BentoExportEventRow {
  attributes?: {
    email?: string | null
    data?: {
      details?: Record<string, unknown>
    }
  }
}

interface BentoExportPage {
  data?: BentoExportEventRow[]
  meta?: {
    next_cursor?: string | null
    truncated?: boolean
  }
}

type EmailCountField = 'sent' | 'delivered' | 'opened' | 'opt_outs'

interface MutableEmailBucket {
  sent: number
  delivered: number
  opened: number
  opt_outs: number
  partial: boolean
}

const MAX_EXPORT_PAGES = 3
const EXPORT_LIMIT = '500'
const BENTO_EXPORT_RATE_LIMIT_RETRIES = 2
const BENTO_EXPORT_429_FALLBACK_MS = 1_000

const EVENT_TYPE_FIELDS: readonly { field: EmailCountField, eventType: string }[] = [
  { field: 'sent', eventType: SECURITY_ADVISORY_EMAIL_SENT_EVENT },
  { field: 'delivered', eventType: SECURITY_ADVISORY_EMAIL_DELIVERED_EVENT },
  { field: 'opened', eventType: SECURITY_ADVISORY_EMAIL_OPENED_EVENT },
  { field: 'opt_outs', eventType: SECURITY_ADVISORY_EMAIL_OPT_OUT_EVENT },
]

function normalizeGhsaId(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.toUpperCase() : null
}

function eventMatchesAdvisory(row: BentoExportEventRow, ghsaId: string): boolean {
  const details = row.attributes?.data?.details
  if (!details || typeof details !== 'object')
    return false
  const record = details as Record<string, unknown>
  const fromDetails = normalizeGhsaId(record.ghsa_id ?? record.ghsaId ?? record.advisory_id)
  if (fromDetails === ghsaId)
    return true
  const fromNested = record.advisory
  if (fromNested && typeof fromNested === 'object') {
    const nested = fromNested as Record<string, unknown>
    const nestedId = normalizeGhsaId(nested.ghsa_id ?? nested.id)
    if (nestedId === ghsaId)
      return true
  }
  return false
}

function emptyEmailStats(bentoConfigured: boolean): SecurityAdvisoryBentoEmailStats {
  return {
    sent: 0,
    delivered: 0,
    opened: 0,
    opt_outs: 0,
    bento_configured: bentoConfigured,
    partial: false,
  }
}

function newEmailBucket(): MutableEmailBucket {
  return { sent: 0, delivered: 0, opened: 0, opt_outs: 0, partial: false }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function rateLimitDelayMs(error: BentoApiError): number {
  const fromHeader = error.retryAfterSeconds
  if (fromHeader != null && Number.isFinite(fromHeader))
    return Math.min(Math.max(fromHeader, 0), 30) * 1000
  return BENTO_EXPORT_429_FALLBACK_MS
}

async function fetchExportEventsPage(
  c: Context,
  eventType: string,
  cursor?: string,
): Promise<{ payload: BentoExportPage | null, partial: boolean }> {
  const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
  const query: Record<string, string> = {
    type: eventType,
    limit: EXPORT_LIMIT,
  }
  if (cursor)
    query.cursor = cursor

  for (let attempt = 0; attempt <= BENTO_EXPORT_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const response = await bentoGet(c, 'fetch/exports/events', siteUuid, query, AbortSignal.timeout(10_000))
      if (response == null)
        return { payload: null, partial: true }
      return { payload: response as BentoExportPage, partial: false }
    }
    catch (error) {
      if (error instanceof BentoApiError && error.status === 429 && attempt < BENTO_EXPORT_RATE_LIMIT_RETRIES) {
        await sleep(rateLimitDelayMs(error))
        continue
      }
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Bento export page fetch failed',
        eventType,
        error: serializeError(error),
      })
      return { payload: null, partial: true }
    }
  }

  return { payload: null, partial: true }
}

async function scanEventTypeForAdvisories(
  c: Context,
  eventType: string,
  field: EmailCountField,
  ghsaIds: readonly string[],
  buckets: Map<string, MutableEmailBucket>,
) {
  let cursor: string | undefined
  let typePartial = false

  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const { payload, partial } = await fetchExportEventsPage(c, eventType, cursor)
    if (partial)
      typePartial = true
    if (payload == null) {
      typePartial = true
      break
    }

    const rows = payload.data ?? []
    for (const row of rows) {
      for (const ghsaId of ghsaIds) {
        if (eventMatchesAdvisory(row, ghsaId))
          buckets.get(ghsaId)![field]++
      }
    }

    const truncated = payload.meta?.truncated === true
    const nextCursor = payload.meta?.next_cursor ?? null
    if (truncated || (nextCursor && page === MAX_EXPORT_PAGES - 1))
      typePartial = true
    if (!nextCursor)
      break
    cursor = nextCursor
  }

  if (typePartial) {
    for (const ghsaId of ghsaIds)
      buckets.get(ghsaId)!.partial = true
  }
}

/** One Bento export pass per event type, split counts per advisory (site concurrency safe). */
export async function loadSecurityAdvisoryBentoEmailStatsBatch(
  c: Context,
  ghsaIds: readonly string[],
): Promise<Map<string, SecurityAdvisoryBentoEmailStats>> {
  const normalizedIds = [...new Set(
    ghsaIds
      .map(id => normalizeGhsaId(id))
      .filter((id): id is string => id != null),
  )]

  const result = new Map<string, SecurityAdvisoryBentoEmailStats>()
  for (const id of normalizedIds)
    result.set(id, emptyEmailStats(isBentoConfigured(c)))

  if (normalizedIds.length === 0)
    return result

  if (!isBentoConfigured(c)) {
    for (const id of normalizedIds)
      result.set(id, emptyEmailStats(false))
    return result
  }

  const buckets = new Map<string, MutableEmailBucket>()
  for (const id of normalizedIds)
    buckets.set(id, newEmailBucket())

  try {
    for (const { field, eventType } of EVENT_TYPE_FIELDS)
      await scanEventTypeForAdvisories(c, eventType, field, normalizedIds, buckets)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'loadSecurityAdvisoryBentoEmailStatsBatch failed',
      error: serializeError(error),
    })
    for (const id of normalizedIds)
      buckets.get(id)!.partial = true
  }

  for (const id of normalizedIds) {
    const bucket = buckets.get(id)!
    result.set(id, {
      sent: bucket.sent,
      delivered: bucket.delivered,
      opened: bucket.opened,
      opt_outs: bucket.opt_outs,
      bento_configured: true,
      partial: bucket.partial,
    })
  }

  return result
}

export async function loadSecurityAdvisoryBentoEmailStats(
  c: Context,
  ghsaId: string,
): Promise<SecurityAdvisoryBentoEmailStats> {
  const normalizedId = normalizeGhsaId(ghsaId)
  if (!normalizedId)
    return emptyEmailStats(isBentoConfigured(c))

  const batch = await loadSecurityAdvisoryBentoEmailStatsBatch(c, [normalizedId])
  return batch.get(normalizedId) ?? emptyEmailStats(isBentoConfigured(c))
}
