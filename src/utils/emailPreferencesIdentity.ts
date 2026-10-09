/** Bento visitor ids are UUID-shaped (dashed) or 32 hex chars (footer unsubscribe links). */
const VISITOR_UUID_DASHED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VISITOR_UUID_HEX32_RE = /^[0-9a-f]{32}$/i

export function isVisitorUuid(value: string): boolean {
  const trimmed = value.trim()
  return VISITOR_UUID_DASHED_RE.test(trimmed) || VISITOR_UUID_HEX32_RE.test(trimmed)
}

/** Vue Router may supply string[] when a query key is repeated. */
function readQueryParam(value: unknown): string {
  if (value == null)
    return ''
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = typeof entry === 'string' ? entry.trim() : ''
      if (trimmed)
        return trimmed
    }
    return ''
  }
  if (typeof value === 'string')
    return value.trim()
  return ''
}

export function parseEmailPreferencesQuery(query: Record<string, unknown>): {
  email: string
  visitorUuid: string
} {
  const rawEmail = readQueryParam(query.email)
  const rawUuid = readQueryParam(query.uuid)
  const rawId = readQueryParam(query.id)

  let visitorUuid = ''
  if (isVisitorUuid(rawUuid))
    visitorUuid = rawUuid.trim()
  else if (isVisitorUuid(rawId))
    visitorUuid = rawId.trim()
  else if (isVisitorUuid(rawEmail))
    visitorUuid = rawEmail.trim()

  const email = rawEmail && !isVisitorUuid(rawEmail) ? rawEmail : ''

  return { email, visitorUuid }
}
