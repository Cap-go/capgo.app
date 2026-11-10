import type { Context } from 'hono'
import { bentoGet, isBentoConfigured } from './bento.ts'
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

const MAX_EXPORT_PAGES = 3
const EXPORT_LIMIT = '500'

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

async function countAdvisoryEvents(
  c: Context,
  eventType: string,
  ghsaId: string,
): Promise<{ count: number, partial: boolean }> {
  const siteUuid = getEnv(c, 'BENTO_SITE_UUID')
  let cursor: string | undefined
  let count = 0
  let partial = false

  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const query: Record<string, string> = {
      type: eventType,
      limit: EXPORT_LIMIT,
    }
    if (cursor)
      query.cursor = cursor

    const response = await bentoGet(c, 'fetch/exports/events', siteUuid, query, AbortSignal.timeout(10_000))
    if (response == null)
      return { count, partial: true }

    const payload = response as BentoExportPage
    const rows = payload.data ?? []
    for (const row of rows) {
      if (eventMatchesAdvisory(row, ghsaId))
        count++
    }

    const truncated = payload.meta?.truncated === true
    const nextCursor = payload.meta?.next_cursor ?? null
    if (truncated || (nextCursor && page === MAX_EXPORT_PAGES - 1))
      partial = true
    if (!nextCursor)
      break
    cursor = nextCursor
  }

  return { count, partial }
}

export async function loadSecurityAdvisoryBentoEmailStats(
  c: Context,
  ghsaId: string,
): Promise<SecurityAdvisoryBentoEmailStats> {
  const normalizedId = normalizeGhsaId(ghsaId)
  if (!normalizedId) {
    return {
      sent: 0,
      delivered: 0,
      opened: 0,
      opt_outs: 0,
      bento_configured: isBentoConfigured(c),
      partial: false,
    }
  }

  if (!isBentoConfigured(c)) {
    return {
      sent: 0,
      delivered: 0,
      opened: 0,
      opt_outs: 0,
      bento_configured: false,
      partial: false,
    }
  }

  try {
    const [sent, delivered, opened, optOuts] = await Promise.all([
      countAdvisoryEvents(c, SECURITY_ADVISORY_EMAIL_SENT_EVENT, normalizedId),
      countAdvisoryEvents(c, SECURITY_ADVISORY_EMAIL_DELIVERED_EVENT, normalizedId),
      countAdvisoryEvents(c, SECURITY_ADVISORY_EMAIL_OPENED_EVENT, normalizedId),
      countAdvisoryEvents(c, SECURITY_ADVISORY_EMAIL_OPT_OUT_EVENT, normalizedId),
    ])

    return {
      sent: sent.count,
      delivered: delivered.count,
      opened: opened.count,
      opt_outs: optOuts.count,
      bento_configured: true,
      partial: sent.partial || delivered.partial || opened.partial || optOuts.partial,
    }
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'loadSecurityAdvisoryBentoEmailStats failed',
      ghsaId: normalizedId,
      error: serializeError(error),
    })
    return {
      sent: 0,
      delivered: 0,
      opened: 0,
      opt_outs: 0,
      bento_configured: true,
      partial: true,
    }
  }
}
